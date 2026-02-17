const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function listGroups() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ["Mishwari Group Lister", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log('✅ Connected! Fetching groups...');

            // Allow some time for sync
            setTimeout(async () => {
                const groups = await sock.groupFetchAllParticipating();
                console.log('\n--- 📋 YOUR GROUPS ---');
                for (const [jid, group] of Object.entries(groups)) {
                    console.log(`Name: ${group.subject}`);
                    console.log(`ID:   ${jid}`);
                    console.log('----------------------');
                }
                console.log('Done.');
                process.exit(0);
            }, 5000);
        }
    });
}

listGroups();
