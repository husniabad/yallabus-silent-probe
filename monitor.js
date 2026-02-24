const { makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const axios = require('axios');
const pino = require('pino');
require('dotenv').config();

// Configuration
const fs = require('fs');

// Configuration
const MISHWARI_API = process.env.MISHWARI_API_URL || 'http://localhost:8000/api/fleet-manager/shadow-trips/';
// Load Specific Group Routing from ENV
// FORMAT (per group value): string operator_id  OR  { operator_id, leader_phones?, default_from_city? }
let GROUP_ROUTING = {};
try {
    const rawRouting = process.env.GROUP_ROUTING_JSON;
    if (rawRouting) {
        // Handle single-quotes in env if present
        let cleanRouting = rawRouting.replace(/^'|'$/g, "");
        GROUP_ROUTING = JSON.parse(cleanRouting);
        console.log(`📋 Loaded specific routing rules for ${Object.keys(GROUP_ROUTING).length} groups.`);
    }
} catch (e) {
    console.error("⚠️ Failed to parse GROUP_ROUTING_JSON from .env:", e.message);
}

/**
 * Resolve routing config for a group JID.
 * Supports legacy string values (just operator_id) and new object format.
 * Returns: { operator_id, leaderPhones: Set<string>, default_from_city }
 */
function resolveGroupRouting(groupId) {
    const raw = GROUP_ROUTING[groupId];

    if (!raw) {
        // Not in routing table → general
        return { operator_id: 'OP_GENERAL', leaderPhones: new Set(), default_from_city: null };
    }

    if (typeof raw === 'string' || typeof raw === 'number') {
        // Legacy format: just the operator_id
        return { operator_id: String(raw), leaderPhones: new Set(), default_from_city: null };
    }

    // Rich format: { operator_id, leader_phones?, default_from_city? }
    const leaderPhones = new Set(
        (raw.leader_phones || []).map(p => {
            // Normalize leader phones same way cleanPhone does
            const cleaned = String(p).replace(/\D/g, '');
            if (cleaned.startsWith('967')) return cleaned.substring(3);
            return cleaned;
        }).filter(p => p.length > 0)
    );

    return {
        operator_id: String(raw.operator_id || 'OP_GENERAL'),
        leaderPhones,
        default_from_city: raw.default_from_city || null,
    };
}

// Check critical env
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ ERROR: Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", generationConfig: { responseMimeType: "application/json" } });

// ── RECONNECTION STATE ──────────────────────────────────────────────────
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;       // Give up after 5 consecutive failures
const INITIAL_DELAY_MS = 5000;          // Start at 5 seconds
const COOLDOWN_MS = 30 * 60 * 1000;    // 30-minute cooldown after max retries
// ────────────────────────────────────────────────────────────────────────

function cleanPhone(jidOrPhone) {
    if (!jidOrPhone) return null;
    if (jidOrPhone.includes('@lid')) return null;

    let p = jidOrPhone.split('@')[0];
    p = p.replace(/\D/g, ''); // Remove non-digits

    // Case 1: International Format 9677xxxxxxxxx
    if (p.startsWith('967')) {
        p = p.substring(3); // Remove 967
    }

    // Case 2: Local Format (must be 9 digits and start with 7)
    // Valid Prefixes: 70, 71, 73, 77, 78, 79(maybe?) - Stick to 7
    // Standard length is 9 digits (e.g. 770551092)
    if (p.length === 9 && /^[7][01378]\d{7}$/.test(p)) {
        return p;
    }

    return null; // Invalid or Foreign number
}




// Refinement Logic
async function refineDriverName(extractedName, senderName) {
    extractedName = (extractedName || "").trim();
    senderName = (senderName || "").trim();

    // 1. Initial Validation (Regex)
    // Accept if: Arabic chars + spaces, at least 2 words, doesn't start with Abu/Bu
    const isArabic = /^[\u0600-\u06FF\s]+$/.test(extractedName);
    const words = extractedName.split(/\s+/).filter(w => w.length > 1);
    const hasTwoWords = words.length >= 2;
    const startsWithAbu = /^(ابو)\s+/.test(extractedName);

    if (isArabic && hasTwoWords && !startsWithAbu) {
        return extractedName; // Optimal
    }

    console.log(`🔧 Refining Name: '${extractedName}' (Sender: '${senderName}')...`);

    // 2. LLM Refinement
    const refinementPrompt = `
    I have a potentially incomplete driver name: "${extractedName}"
    And the Message Sender Name: "${senderName}"

    Task: Generate the **Best Possible 2-Word Arabic Name** for the driver.
    
    Rules:
    1. If "${extractedName}" contains a real name (e.g. "Ahmed Ali"), return it in Arabic.
    2. If it is a nickname (starts with Abu/Bu) or empty, check "${senderName}".
    3. If "${senderName}" is a valid 2-word name (English or Arabic), Convert it to Arabic and return it.
    4. If you cannot find a valid 2-word name, return null.
    
    Output JSON ONLY: { "refined_name": "string or null" }
    `;

    try {
        const result = await model.generateContent(refinementPrompt);
        const response = await result.response;
        const text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const json = JSON.parse(text);

        if (json.refined_name) {
            console.log(`   ✅ Refined to: ${json.refined_name}`);
            return json.refined_name;
        }
    } catch (e) {
        console.error("   ⚠️ Refinement failed, using original.");
    }

    return extractedName || null; // Fallback
}


async function processTripData(text, senderName, operatorId, groupId, senderRaw, defaultOrigin, leaderPhones = new Set()) {
    console.log(`📩 Valid Message from Sender: ${senderRaw}`);
    try {
        console.log(`[Gemini] Analyzing text...`);

        // Context for Date Resolution
        // Context for Date Resolution - STRICTLY ADEN TIME
        function getAdenDate() {
            const d = new Date();
            return new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Aden' }));
        }

        function formatAdenDate(dateObj) {
            const y = dateObj.getFullYear();
            const m = String(dateObj.getMonth() + 1).padStart(2, '0');
            const d = String(dateObj.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        const nowAden = getAdenDate();
        const todayStr = formatAdenDate(nowAden);
        const dayName = nowAden.toLocaleDateString('en-US', { weekday: 'long' }); // already shifted
        const timeStr = nowAden.toLocaleTimeString('en-US', { hour12: false }); // already shifted
        const currentHour = nowAden.getHours();

        // Ramadan 2026: Feb 18 – Mar 20
        const month = nowAden.getMonth() + 1; // 1-indexed
        const day = nowAden.getDate();
        const isRamadan = (month === 2 && day >= 18) || (month === 3 && day <= 20);
        const lateCutoff = isRamadan ? 15 : 20;

        let defaultDateRule = "Today";
        if (currentHour >= lateCutoff) {
            defaultDateRule = "Tomorrow";
        }

        const prompt = `
        You are a data extraction system for a Yemeni bus company.
        Today is **${dayName}, ${todayStr}**.
        Current Time (Aden): **${timeStr}**.
        It is currently **Ramadan** in Yemen.
        Sender Name: "**${senderName}**".

        Extract trip details from the text.
        
        **CRITICAL RULES FOR CITIES**:
        1. **Standardize Names**: Always map to the OFFICIAL Arabic name.
           - "سيون" -> "سيئون"
           - "صنعا" -> "صنعاء"
           - "شبوة" -> "عتق" (or vice versa, prefer "عتق")
           - "المكلاء" -> "المكلا"
        2. **Major City Priority**: If multiple cities are listed (e.g. "سيئون - تريم"), ONLY extract the MAJOR city ("سيئون").
        3. **Official List**: [صنعاء, عدن, سيئون, المكلا, عتق, الحديدة, تعز, مأرب, تريم, بيحان, الحوبان, القطن].

        **CRITICAL RULES FOR DATE**:
        - "بكره" / "بكرة" / "غداً" = Tomorrow
        - "اليوم" = Today
        - "بعد بكره" / "بعد بكرة" = Day after tomorrow
        - If text says a DAY NAME (e.g. "الجمعه", "السبت", "الاحد"):
          * If that day is TODAY, return "Today"
          * If that day is TOMORROW, return "Tomorrow"
          * Otherwise compute the YYYY-MM-DD of the NEXT occurrence of that day
        - **SMART INFERENCE**: If the text mentions a TIME PERIOD (e.g. "صباح", "بعد الظهر", "بعد صلاة الجمعة") but NO explicit date:
          * Compare the mentioned time with the CURRENT TIME (${timeStr}).
          * If that time has ALREADY PASSED today, the trip is for **Tomorrow**.
          * If that time is STILL COMING today, the trip is for **Today**.
          * Example: If current time is 21:00 and text says "after noon" → Tomorrow.
          * Example: If current time is 08:00 and text says "afternoon" → Today.
        - If NO date clue at all: return null
        - Output the date field as: "Today", "Tomorrow", "After Tomorrow", or "YYYY-MM-DD"

        **CRITICAL RULES FOR TIME**:
        - Common Arabic time references:
          * "صباح" / "صباحاً" = "07:00"
          * "فجر" = "05:00"
          * "ظهر" / "بعد الظهر" = "12:00"
          * "عصر" / "بعد العصر" = "15:00"
          * "مساء" / "مساءً" = "18:00"
          * "ليل" = "21:00"
        - During Ramadan, additional time references:
          * "بعد الإفطار" / "بعد الفطور" = "19:00"
          * "بعد التراويح" = "21:00"
          * "سحور" / "قبل السحور" = "03:00"
          * "بعد صلاة الجمعة" / "بعد صلاة الجمعه" = "13:30"
        - If an explicit clock time is mentioned (e.g. "الساعة 4", "3 عصراً"), convert to HH:MM 24h.
        - Extract time as HH:MM (24h format) when possible.
        - Return null ONLY if the text has absolutely NO time or period reference.

        **OTHER RULES**:
        - **Driver Name**: Extract the **Real Full Name** (First + Last).
          - MUST be **Arabic**.
          - MUST be at least **2 words** (e.g. "محمد علي", "صالح احمد").
          - Avoid Nicknames like "ابو محمد" (Abu Muhammad) or "بو صالح" unless no other name exists.
          - If NO name is in text, look at **Sender Name** "${senderName}".
        - **Driver Name Cleaning**: If text has "Ramzi Mkaram (Abu Hadi)", extract ONLY "رمزي مكارم".
        - **candidate_phones**: Extract ALL phone numbers found as an array of strings.
        - **vehicle_raw**: Extract bus type exactly as written (e.g. "نوها", "فكسي", "قبة", "باص"). 

        **CLASSIFICATION RULE**:
        First, decide if this text is a valid **TRIP ANNOUNCEMENT**.
        - RETURNS "trip" IF: Text announces a travel trip, bus schedule, or driver seeking passengers.
        - RETURNS "invalid_ad" IF: Text is selling products (furniture, qat, cars, items), real estate, or general spam.
        - RETURNS "question" IF: User is asking for a trip (passenger) rather than offering one.

        Extract details into a JSON object:
        - classification (string: "trip" | "invalid_ad" | "question")
        - driver_name (string or null)
        - candidate_phones (array of strings)
        - from_city (string or null, OFFICIAL name only)
        - to_city (string or null, OFFICIAL name only)
        - date (string or null: "Today", "Tomorrow", "After Tomorrow", or "YYYY-MM-DD")
        - time (string or null, HH:MM 24h format e.g. "08:00", "19:00")
        - vehicle_raw (string or null)
        - price (number or null)

        Text to analyze: "${text}"
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const jsonText = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(jsonText);

        // --- CHECK CLASSIFICATION FIRST ---
        if (data.classification === 'invalid_ad' || data.classification === 'question') {
            console.log(`⚠️  Gemini ignored text. Classification: [${data.classification}]`);
            return; // STOP
        }

        // --- NAME REFINEMENT ---
        data.driver_name = await refineDriverName(data.driver_name, senderName);

        // If refinement failed to produce ANY name, and we requested to "fall back to case of not creating"
        if (!data.driver_name) {
            console.log("⚠️ No valid driver name found after refinement. Skipping.");
            return;
        }

        // Apply Default Origin if missing
        // If "From" is missing (after default check), stop creation.
        if (!data.from_city && defaultOrigin) {
            console.log(`🔹 Applying default origin: ${defaultOrigin}`);
            data.from_city = defaultOrigin;
        }

        // --- DATE PARSING ---
        const tomorrow = new Date(nowAden);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = formatAdenDate(tomorrow);
        const afterTomorrow = new Date(nowAden);
        afterTomorrow.setDate(afterTomorrow.getDate() + 2);
        const afterTomorrowStr = formatAdenDate(afterTomorrow);

        // Day-of-week resolver: find next occurrence of a given day (0=Sun, 6=Sat)
        function getNextDayOfWeek(dayIndex) {
            const d = getAdenDate(); // Use Aden time!
            const currentDay = d.getDay();
            let diff = dayIndex - currentDay;
            if (diff < 0) diff += 7;
            if (diff === 0) diff = 7; // same day = next week
            d.setDate(d.getDate() + diff);
            return formatAdenDate(d);
        }

        // Arabic day name -> JS day index
        const DAY_MAP = {
            'السبت': 6, 'الاحد': 0, 'الأحد': 0,
            'الاثنين': 1, 'الإثنين': 1, 'الثلاثاء': 2, 'الثلاثا': 2,
            'الاربعاء': 3, 'الأربعاء': 3, 'الخميس': 4,
            'الجمعه': 5, 'الجمعة': 5,
            'saturday': 6, 'sunday': 0, 'monday': 1, 'tuesday': 2,
            'wednesday': 3, 'thursday': 4, 'friday': 5,
        };

        if (data.date) {
            const lowerDate = data.date.toLowerCase().trim();

            if (lowerDate.includes('after') && lowerDate.includes('tomorrow') || lowerDate.includes('بعد بكر') || lowerDate.includes('بعد غد')) {
                data.date = afterTomorrowStr;
            } else if (lowerDate.includes('tomorrow') || lowerDate.includes('غد') || lowerDate.includes('بكر')) {
                data.date = tomorrowStr;
            } else if (lowerDate.includes('today') || lowerDate.includes('اليوم')) {
                data.date = todayStr;
            } else if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
                // Check if it's a day name
                let resolved = false;
                for (const [dayName, dayIdx] of Object.entries(DAY_MAP)) {
                    if (lowerDate.includes(dayName)) {
                        // If today IS that day, use today
                        if (nowAden.getDay() === dayIdx) {
                            data.date = todayStr;
                        } else {
                            data.date = getNextDayOfWeek(dayIdx);
                        }
                        resolved = true;
                        break;
                    }
                }
                if (!resolved) {
                    console.log(`⚠️ Date '${data.date}' not resolved. Defaulting to ${defaultDateRule}.`);
                    data.date = defaultDateRule === 'Tomorrow' ? tomorrowStr : todayStr;
                }
            }
        } else {
            // Missing date -> use heuristic
            data.date = defaultDateRule === 'Tomorrow' ? tomorrowStr : todayStr;
        }

        // SAFETY CHECK: If date is Today but extracted time has already passed → bump to Tomorrow
        if (data.date === todayStr && data.time) {
            const timeMatch = data.time.match(/^(\d{1,2}):(\d{2})$/);
            if (timeMatch) {
                const tripHour = parseInt(timeMatch[1], 10);
                const tripMin = parseInt(timeMatch[2], 10);
                if (currentHour > tripHour || (currentHour === tripHour && parseInt(timeStr.split(':')[1], 10) > tripMin)) {
                    console.log(`🔄 Time ${data.time} already passed today (now ${timeStr}). Bumping date to Tomorrow.`);
                    data.date = tomorrowStr;
                }
            }
        }

        // --- STRICT USER REQUIREMENT: Stop Creation Logic ---

        // 1. Driver Name Logic:
        // 1. Driver Name Logic: (Handled by Gemini Fallback Rule)

        if (!data.driver_name) {
            console.log(`⚠️  Driver name missing & sender name '${senderName}' is invalid. Skipping.`);
            return; // STOP CREATION
        }


        // 2. Ensure we have From & To
        if (!data.from_city || !data.to_city) {
            console.log("⚠️  Skipping: Missing 'from_city' or 'to_city'.", { from: data.from_city, to: data.to_city });
            return; // STOP CREATION
        }

        // 3. Validate cities against allowed list (must match backend stations)
        const VALID_CITIES = ['سيئون', 'المكلا', 'عدن', 'عتق', 'بيحان', 'تريم', 'صنعاء', 'الحديدة', 'تعز', 'مأرب', 'الحوبان', 'القطن'];
        if (!VALID_CITIES.includes(data.from_city) || !VALID_CITIES.includes(data.to_city)) {
            console.log(`⚠️  Skipping: Invalid city detected. from='${data.from_city}' to='${data.to_city}'. Allowed: [${VALID_CITIES.join(', ')}]`);
            return; // STOP CREATION
        }

        // 3. Phone Logic:
        //    - Filter candidates first. If NONE valid, try sender.
        //    - Then remove known leader/office/agent phones (per-group blocklist).
        //    - If ALL remaining are leader phones, attempt name-only lookup on backend.
        let rawCandidates = data.candidate_phones || [];
        let validCandidates = [];

        // First, check text-extracted numbers
        for (const raw of new Set(rawCandidates)) {
            const cleaned = cleanPhone(raw);
            if (cleaned) validCandidates.push(cleaned);
            else console.log(`   ⚠️ Ignoring invalid/foreign phone: ${raw}`);
        }

        // If no valid numbers found in text, fallback to Sender
        if (validCandidates.length === 0 && senderRaw) {
            console.log("🔹 No valid Yemen phones in text, checking sender...");
            const senderClean = cleanPhone(senderRaw);
            if (senderClean) {
                validCandidates.push(senderClean);
                console.log(`   ✅ Using Sender Phone: ${senderClean}`);
            } else {
                console.log(`   ⚠️ Sender phone also invalid/foreign: ${senderRaw}`);
            }
        } else if (validCandidates.length > 0) {
            console.log(`🔹 Found ${validCandidates.length} valid Yemen phones in text.`);
        }

        if (validCandidates.length === 0) {
            console.log("⚠️  Skipping: No valid Yemen phone numbers found (Sender might be hidden/LID).");
            return;
        }

        // ── LEADER PHONE FILTERING ───────────────────────────────────────────
        // Remove known office/agent/leader phones from the candidate list.
        // These numbers appear across many drivers and should NEVER be used
        // as the primary driver identifier.
        let leaderPhoneFallback = null; // set if we fall back to a leader phone
        if (leaderPhones.size > 0) {
            const leaderFiltered = validCandidates.filter(p => !leaderPhones.has(p));
            const removedCount = validCandidates.length - leaderFiltered.length;

            if (removedCount > 0) {
                console.log(`🚫 Filtered out ${removedCount} known leader/agent phone(s): [${validCandidates.filter(p => leaderPhones.has(p)).join(', ')}]`);
            }

            if (leaderFiltered.length > 0) {
                // Good: we have driver-specific numbers
                validCandidates = leaderFiltered;
                console.log(`✅ Driver-specific candidates after filter: [${validCandidates.join(', ')}]`);
            } else {
                // All phones in this message are leader/agent phones.
                // Strategy: pick one of them as the trip anchor and create/update
                // the driver record with the extracted driver name.
                // The backend will bypass the name-mismatch check for this path.
                leaderPhoneFallback = validCandidates[0]; // pick first leader phone
                validCandidates = [leaderPhoneFallback];
                console.log(`⚠️  All candidates are leader phones. Using leader phone fallback: ${leaderPhoneFallback} → driver: "${data.driver_name}"`);
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        console.log("✅ Trip Detected & Validated:", {
            driver: data.driver_name,
            from: data.from_city,
            to: data.to_city,
            phones: validCandidates,
            // Extra Data
            price: data.price,
            date: data.date,
            time: data.time,
            vehicle: data.vehicle_raw
        });

        let success = false;

        // ── NORMAL PATH: Try each driver-specific phone ───────────────────────
        for (const finalPhone of validCandidates) {
            console.log(`   Trying Phone Candidate: ${finalPhone} for Driver: ${data.driver_name}${leaderPhoneFallback ? ' [leader-phone-fallback]' : ''}`);

            try {
                const res = await axios.post(MISHWARI_API, {
                    ...data,
                    phone: finalPhone, // Normalized Override
                    // Flag for backend: skip name-mismatch check when using a shared leader phone
                    leader_phone_fallback: leaderPhoneFallback !== null,
                    original_text: text,
                    reported_by: senderName,
                    operator_id: operatorId,
                    source_group: groupId
                }, {
                    headers: { 'X-Probe-Key': process.env.MISHWARI_API_KEY }
                });

                const resData = res.data;
                console.log(`🚀 Uploaded to Mishwari using phone ${finalPhone}`);
                console.log(`   ✅ Backend: ${resData.message} | Created: ${resData.created_count} | Errors: ${resData.error_count}`);
                if (resData.trips && resData.trips.length > 0) {
                    console.log(`   🆔 Trip ID: ${resData.trips[0].id}`);
                }
                success = true;
                break; // Stop trying numbers
            } catch (apiError) {
                const errData = apiError.response?.data;
                const statusCode = apiError.response?.status;

                // 400 errors (validation failures) -> try next phone
                if (statusCode === 400) {
                    console.warn(`   ⚠️ Rejected phone ${finalPhone}: ${errData?.errors?.[0]?.error || apiError.message}. Trying next...`);
                    continue;
                }

                // Other errors (500, network, etc.) -> stop
                console.error("❌ API Error:", apiError.message);
                if (apiError.response) console.error("   Response:", apiError.response.data);
                break;
            }
        }

        if (!success) {
            console.log("❌ Failed to bind trip to any candidate phone number.");
        }
    } catch (e) {
        console.error("❌ Processing Error:", e.message);
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Mishwari Probe", "Chrome", "1.0.0"]
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            const remoteJid = msg.key.remoteJid;

            // FIX: Prefer participantAlt (phone JID) over participant (LID)
            const rawParticipant = msg.key.participantAlt || msg.key.participant || remoteJid;
            const participant = jidNormalizedUser(rawParticipant);

            console.log("👤 Resolved Participant:", participant);

            // FILTER 1: Must be a Group
            if (!remoteJid.endsWith('@g.us')) continue;

            // ROUTING LOGIC — uses resolveGroupRouting for rich config support
            const routingConfig = resolveGroupRouting(remoteJid);
            const routing = {
                operator_id: routingConfig.operator_id,
                leaderPhones: routingConfig.leaderPhones,
                default_from_city: routingConfig.default_from_city,
                name: GROUP_ROUTING[remoteJid] ? "Specific Group" : "General Group",
            };

            // FILTER 2: Ignore Self & Status
            if (msg.key.fromMe) continue;
            if (remoteJid === 'status@broadcast') continue;

            const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption;

            if (!text) continue;

            // FILTER 3: Keyword Check (English + Arabic)
            // Arabic: صنعاء, عدن, سيئون, المكلا, بيحان, عتق, ركاب, باص, رحلة, متواجد, مسافر, متحرك, سيتحرك
            const KEYWORD_REGEX = /(?:صنعاء|عدن|سيئون|المكلا|تريم|بيحان|عتق|القطن|ركاب|باص|رحلة|متواجد|طالع|نازل|مسافر|متحرك|سيتحرك|سوف يتحرك)/i;

            if (!text.match(KEYWORD_REGEX)) {
                continue;
            }

            // FILTER 4: Reject Saudi/Foreign city mentions oe selling ads (save LLM calls)
            const SAUDI_AND_SELLING_REGEX = /(?:للبيع|بيع|شراء|للإيجار|للتأجير|عقار|شقة|أرض|وظيفة|توظيف|مطلوب موظف|مندوب|تسليم|عرض خاص|تخفيض|الرياض|جدة|جده|مكة|مكه|الطائف|الدمام|الخبر|المدينة|المدينه|تبوك|أبها|ابها|نجران|جيزان|جازان|خميس مشيط|ينبع|شرورة|شروره|حائل|الجبيل|القصيم|بريدة|صلالة|صلاله|المزيونة|المزيونه|ثمريت|هيما)/;
            if (text.match(SAUDI_AND_SELLING_REGEX)) {
                console.log(`⚠️  Skipping: Saudi/foreign city or selling ads detected in message.`);
                continue;
            }


            console.log(`\n🔍 Valid Message Detected!`);
            console.log(`   - Group ID: ${remoteJid}`);
            console.log(`   - Group Name: ${routing.name}`);
            console.log(`   - Sender: ${participant}`);
            console.log("   - Message Data:", JSON.stringify(msg, null, 2));

            console.log(`[Probe] Processing trip from [${routing.name}] -> Assigned to: ${routing.operator_id}`);

            console.log(`🚀 Dispatching Trip for Sender JID: ${participant}`);

            // Pass default_from_city and leaderPhones if configured
            const defaultCity = routing.default_from_city || null;
            await processTripData(text, msg.pushName || "Unknown", routing.operator_id, remoteJid, participant, defaultCity, routing.leaderPhones);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("Generating QR Code...");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (status: ${statusCode}), shouldReconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                reconnectAttempts++;

                if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                    console.error(`❌ Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts. Entering 30-minute cooldown...`);
                    setTimeout(() => {
                        console.log('⏰ Cooldown over. Resetting and trying to reconnect...');
                        reconnectAttempts = 0;
                        connectToWhatsApp();
                    }, COOLDOWN_MS);
                } else {
                    const delay = INITIAL_DELAY_MS * Math.pow(2, reconnectAttempts - 1); // 5s, 10s, 20s, 40s, 80s
                    console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                    setTimeout(connectToWhatsApp, delay);
                }
            } else {
                console.error('🚪 Logged out. Not reconnecting. Re-authenticate manually.');
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0; // ← Reset on successful connection
            console.log('✅ Mishwari Silent Probe (Gemini Edition) is Online & Listening');
            if (Object.keys(GROUP_ROUTING).length > 0) {
                console.log(`📋 Routing rules loaded: ${Object.keys(GROUP_ROUTING).length} specific groups defined.`);
            }

            console.log('\n✅ Connected to WA Server!\n');

            // List all joined groups
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.values(groups);
                console.log(`📋 Joined Groups (${groupList.length}):`);
                console.log('─'.repeat(80));
                for (const g of groupList) {
                    const routingType = GROUP_ROUTING[g.id] ? `Specific (Op: ${GROUP_ROUTING[g.id]})` : 'General';
                    console.log(`   ${g.subject.padEnd(40)} | ${g.id} | ${routingType}`);
                }
                console.log('─'.repeat(80));
            } catch (e) {
                console.warn('⚠️ Could not fetch group list:', e.message);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
