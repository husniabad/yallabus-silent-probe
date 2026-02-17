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
let GROUP_CONFIG = {};

try {
    GROUP_CONFIG = JSON.parse(fs.readFileSync('groups.config.json', 'utf8'));
} catch (e) {
    console.error("⚠️  Could not load groups.config.json. Using default fallback.");
    GROUP_CONFIG = { groups: {}, default: { operator_id: "OP_GENERAL" } };
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
    p = p.replace(/\D/g, '');
    return p.length >= 9 ? p : null;
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
        - **Driver Name Fallback**: If NO driver name is explicitly mentioned in the text, check the **Sender Name**. If the Sender Name is a valid, real person's name (Arabic), use it as 'driver_name'. If it is a nickname (Abu X only) or company name, DO NOT use it.
        - **Driver Name Cleaning**: If the text contains a full name (e.g. 'Ramzi Mkaram') AND a nickname (e.g. 'Abu Hadi'), ONLY extract the full name. Exclude "Abu ..." or "Bin ..." if a real name exists.
        - **candidate_phones**: Extract ALL phone numbers found as an array of strings.
        - **vehicle_raw**: Extract bus type exactly as written (e.g. "نوها", "فكسي", "قبة", "باص"). 

        Extract details into a JSON object:
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

        // 3. Phone Logic:
        //    - "Only pick sender number if not exists in chat"
        let rawCandidates = data.candidate_phones || [];

        if (rawCandidates.length === 0 && senderRaw) {
            console.log("🔹 No phones in text, checking sender...");
            rawCandidates.push(senderRaw);
        } else if (rawCandidates.length > 0) {
            console.log(`🔹 Found ${rawCandidates.length} phones in text. Ignoring sender phone.`);
        }

        // Validate Candidates NOW
        const validCandidates = [];
        for (const raw of new Set(rawCandidates)) {
            const cleaned = cleanPhone(raw);
            if (cleaned) validCandidates.push(cleaned);
        }

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
                await axios.post(MISHWARI_API, {
                    ...data,
                    phone: finalPhone, // Normalized Override
                    original_text: text,
                    reported_by: senderName,
                    operator_id: operatorId,
                    source_group: groupId
                }, {
                    headers: { 'X-Probe-Key': process.env.MISHWARI_API_KEY }
                });

                console.log(`🚀 Uploaded to Mishwari using phone ${finalPhone}`);
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
            let routing = GROUP_CONFIG.groups[remoteJid];
            let groupName = routing ? routing.name : "Unknown Group";

            // If not explicitly defined, fallback to default
            if (!routing) {
                routing = GROUP_CONFIG.default || { operator_id: 'OP_GENERAL' };
            }

            // FILTER 2: Ignore Self & Status
            if (msg.key.fromMe) continue;
            if (remoteJid === 'status@broadcast') continue;

            const text = msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption;

            if (!text) continue;

            // FILTER 3: Keyword Check (English + Arabic)
            // Keywords based on real samples: 
            // English: to, from, driver, 77x, trip
            // Arabic: صنعاء, عدن, سيئون, المكلا, بيحان, عتق, ركاب, باص, رحلة, متواجد, مسافر, متحرك, سيتحرك
            const KEYWORD_REGEX = /(?:to|from|driver|77\d{7}|trip|sana'a|aden|صنعاء|عدن|سيئون|المكلا|بيحان|عتق|ركاب|باص|رحلة|متواجد|مسافر|متحرك|سيتحرك)/i;

            if (!text.match(KEYWORD_REGEX)) {
                continue;
            }


            console.log(`\n🔍 Valid Message Detected!`);
            console.log(`   - Group ID: ${remoteJid}`);
            console.log(`   - Group Name: ${groupName}`);
            console.log(`   - Sender: ${participant}`);
            console.log("   - Message Data:", JSON.stringify(msg, null, 2));

            console.log(`[Probe] Processing trip from [${groupName}] -> Assigned to: ${routing.operator_id}`);

            console.log(`🚀 Dispatching Trip for Sender JID: ${participant}`);

            // Pass default_from_city if configured
            const defaultCity = routing.default_from_city || null;
            await processTripData(text, msg.pushName || "Unknown", routing.operator_id, remoteJid, participant, defaultCity);
        }
    });

    sock.ev.on('connection.update', (update) => {
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
            if (GROUP_CONFIG.groups) {
                console.log(`📋 Routing rules loaded: ${Object.keys(GROUP_CONFIG.groups).length} specific groups defined.`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();
