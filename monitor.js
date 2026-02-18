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

// Check critical env
if (!process.env.GEMINI_API_KEY) {
    console.error("❌ ERROR: Missing GEMINI_API_KEY in .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", generationConfig: { responseMimeType: "application/json" } });

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


async function processTripData(text, senderName, operatorId, groupId, senderRaw, defaultOrigin) {
    console.log(`📩 Valid Message from Sender: ${senderRaw}`);
    try {
        console.log(`[Gemini] Analyzing text...`);

        // Context for Date Resolution
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Aden' });

        // Time Heuristic: 
        // If current time is late (e.g. > 20:00), default to Tomorrow.
        // If it's early morning (e.g. 01:00), it IS the day of the trip, so default to Today.
        const timeStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'Asia/Aden' });
        const currentHour = parseInt(timeStr.split(':')[0], 10);

        let defaultDateRule = "Today";
        if (currentHour >= 20) {
            defaultDateRule = "Tomorrow";
        }

        const prompt = `
        You are a data extraction system for a Yemeni bus company.
        Today is **${dayName}, ${todayStr}**.
        Current Time (Aden): **${timeStr}**.
        Sender Name: "**${senderName}**".

        Extract trip details from the text.
        
        **CRITICAL RULES FOR CITIES**:
        1. **Standardize Names**: Always map to the OFFICIAL Arabic name.
           - "سيون" -> "سيئون"
           - "صنعا" -> "صنعاء"
           - "شبوة" -> "عتق" (or vice versa, prefer "عتق")
        2. **Major City Priority**: If multiple cities are listed (e.g. "سيئون - تريم"), ONLY extract the MAJOR city ("سيئون").
        3. **Official List**: [صنعاء, عدن, سيئون, المكلا, عتق, الحديدة, تعز, مأرب, تريم, بيحان, الحوبان].

        **OTHER RULES**:
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
        - date (string or null, e.g. "Tomorrow", "Friday", or YYYY-MM-DD)
        - time (string or null, e.g. "08:00", "4 PM", "16:00")
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
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        if (data.date) {
            const lowerDate = data.date.toLowerCase();
            const afterTomorrow = new Date(now);
            afterTomorrow.setDate(afterTomorrow.getDate() + 2);
            const afterTomorrowStr = afterTomorrow.toISOString().split('T')[0];

            if (lowerDate.includes('tomorrow') || lowerDate.includes('ghadan') || lowerDate.includes('bukra')) {
                data.date = tomorrowStr;
            } else if (lowerDate.includes('today') || lowerDate.includes('alyoum')) {
                data.date = todayStr;
            } else if (lowerDate.includes('after') && (lowerDate.includes('tomorrow') || lowerDate.includes('bukra'))) {
                data.date = afterTomorrowStr;
            } else if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
                // Try to keep it if it looks like a date, otherwise default
                // Simple check: if it has digits and dashes/slashes
                console.log(`⚠️ Date '${data.date}' not strict YYYY-MM-DD. Defaulting to Tomorrow.`);
                data.date = tomorrowStr;
            }
        } else {
            // Missing date -> Default to Tomorrow
            data.date = tomorrowStr;
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
        const VALID_CITIES = ['سيئون', 'المكلا', 'عدن', 'عتق', 'بيحان', 'تريم', 'صنعاء', 'الحديدة', 'تعز', 'مأرب', 'الحوبان'];
        if (!VALID_CITIES.includes(data.from_city) || !VALID_CITIES.includes(data.to_city)) {
            console.log(`⚠️  Skipping: Invalid city detected. from='${data.from_city}' to='${data.to_city}'. Allowed: [${VALID_CITIES.join(', ')}]`);
            return; // STOP CREATION
        }

        // 3. Phone Logic:
        //    - Filter candidates first. If NONE valid, try sender.
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

        // (Validation loop moved above)

        if (validCandidates.length === 0) {
            console.log("⚠️  Skipping: No valid Yemen phone numbers found (Sender might be hidden/LID).");
            return;
        }

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

        for (const finalPhone of validCandidates) {
            console.log(`   Trying Phone Candidate: ${finalPhone} for Driver: ${data.driver_name}`);

            try {
                const res = await axios.post(MISHWARI_API, {
                    ...data,
                    phone: finalPhone, // Normalized Override
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
            console.log("🔍 FULL MSG:", JSON.stringify(msg, null, 2));
            const remoteJid = msg.key.remoteJid;

            // FIX: Prefer participantAlt (phone JID) over participant (LID)
            const rawParticipant = msg.key.participantAlt || msg.key.participant || remoteJid;
            const participant = jidNormalizedUser(rawParticipant);

            console.log("👤 Resolved Participant:", participant);

            // FILTER 1: Must be a Group
            if (!remoteJid.endsWith('@g.us')) continue;

            // ROUTING LOGIC
            let routing = null;
            let opId = GROUP_ROUTING[remoteJid];

            if (opId) {
                routing = { operator_id: opId, name: "Specific Group" };
            }

            // If not explicitly defined, fallback to null/general
            if (!routing) {
                routing = { operator_id: 'OP_GENERAL', name: 'General Group' };
            }

            // FILTER 2: Ignore Self & Status
            if (msg.key.fromMe) continue;
            if (remoteJid === 'status@broadcast') continue;

            const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption;

            if (!text) continue;

            // FILTER 3: Keyword Check (English + Arabic)
            // Arabic: صنعاء, عدن, سيئون, المكلا, بيحان, عتق, ركاب, باص, رحلة, متواجد, مسافر, متحرك, سيتحرك
            const KEYWORD_REGEX = /(?:صنعاء|عدن|سيئون|المكلا|تريم|بيحان|عتق|ركاب|باص|رحلة|متواجد|طالع|نازل|مسافر|متحرك|سيتحرك|سوف يتحرك)/i;

            if (!text.match(KEYWORD_REGEX)) {
                continue;
            }

            // FILTER 4: Reject Saudi/Foreign city mentions oe selling ads (save LLM calls)
            const SAUDI_AND_SELLING_REGEX = /(?:للبيع|للإيجار|للتأجير|عقار|شقة|أرض|وظيفة|توظيف|مطلوب موظف|مندوب|تسليم|عرض خاص|تخفيض|الرياض|جدة|جده|مكة|مكه|الطائف|الدمام|الخبر|المدينة|المدينه|تبوك|أبها|ابها|نجران|جيزان|جازان|خميس مشيط|ينبع|شرورة|شروره|حائل|الجبيل|القصيم|بريدة|صلالة|صلاله|المزيونة|المزيونه|ثمريت|هيما)/;
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

            // Pass default_from_city if configured
            const defaultCity = routing.default_from_city || null;
            await processTripData(text, msg.pushName || "Unknown", routing.operator_id, remoteJid, participant, defaultCity);
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("Generating QR Code...");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Mishwari Silent Probe (Gemini Edition) is Online & Listening');
            if (Object.keys(GROUP_ROUTING).length > 0) {
                console.log(`📋 Routing rules loaded: ${Object.keys(GROUP_ROUTING).length} specific groups defined.`);
            }

            console.log('\n✅ Connected to WA Server!\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
