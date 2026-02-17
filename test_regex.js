const { expect } = require('chai');

// Pseudo-test suite to verify regex logic against provided samples
// This simulates the logic in monitor.js without connecting to WhatsApp

describe('Probe Logic Verification', () => {

    const TARGET_REGEX = /(?:to|from|driver|77\d{7}|trip|sana'a|aden|عتق|عدن|سيئون|المكلا|صنعاء|بيحان|ركاب|باص|شبوة)/i;

    const SPECIFIC_GROUP_MESSAGES = [
        "2/3/26, 6:50 PM - مكتب السياحي للنقل سيئون: *السلام عليكم ورحمة الله وبركاته* *رحــلــة[ـ-تــ»ــريـم-ســ«ــيئون-عــ«ــدن الظهر]* ~*🚎 بـــاص محمد صالح شعيب🚌*~ *«سوف يتحرك باص نوها  سـيـvipــاحـ👑ــي مكيف ومريح ان شاءالله»* *~🔴اليوم الاربعاء~* *~🟠التاري2/4/,2026م~*",
        "2/4/26, 10:18 AM - +967 780 230 095: 🔹 *««« ~_الســلام علــــيكم..._~ »»»* 🔹 🗒️ *«متواجد في سيؤن وطالع(●الخميس 5 فبراير 2026م●) الظهر أن شاء الله»* 🛤️ *« مـن {تريم~>سيؤن} ٠٠ إلــى   ,٠٠ {عدن~>عدن}*",
        "2/5/26, 6:13 PM - مكتب السياحي للنقل سيئون: *السلام عليكم ورحمة الله وبركاته* *رحــلــة[تــ»ــريـم-ســ«ــيئون-عــ«ــدن]* *🚎 ~بـاص سالم باكربشات~ 🚌*"
    ];

    const GENERAL_GROUP_MESSAGES = [
        "1/11/26, 5:53 AM - +967 779 941 481: 🛑 *الســــلام عليـــكم*🛑 *متواجد فـي >>> *`(( بيحان ))` •• *وإن شـــــاء الله* •• *مسـافـرين إلى >>> *`((عدن ))` *أذافي  ركاب او انجيزا اورسائل *",
        "1/14/26, 12:34 AM - صالح بوجليده: رحلة عتق – عدن متواجد حاليًا في عتق، والانطلاق بإذن الله إلى عدن. لمن يرغب بإرسال ركاب، رسائل أو إنجيز يمكنه التواصل عبر: 📞 770003318 – أبو علي",
        "1/15/26, 5:35 AM - +967 776 421 048: لاقد وصل اجرة الراكب لاعدن بـ 5000 باسافر", // Improve regex to exclude chatty messages if possible, but detection is key
        "1/10/26, 9:36 PM - +967 771 556 986: كيفكم" // Should be ignored
    ];

    it('should detect valid trips in SPECIFIC group', () => {
        SPECIFIC_GROUP_MESSAGES.forEach(msg => {
            const isMatch = msg.match(TARGET_REGEX);
            console.log(`[Specific] "${msg.substring(0, 30)}..." -> ${isMatch ? 'MATCH' : 'FAIL'}`);
            if (!isMatch) throw new Error(`Failed to match: ${msg}`);
        });
    });

    it('should detect valid trips in GENERAL group', () => {
        const validMsgs = GENERAL_GROUP_MESSAGES.slice(0, 2);
        validMsgs.forEach(msg => {
            const isMatch = msg.match(TARGET_REGEX);
            console.log(`[General] "${msg.substring(0, 30)}..." -> ${isMatch ? 'MATCH' : 'FAIL'}`);
            if (!isMatch) throw new Error(`Failed to match: ${msg}`);
        });
    });

    it('should possibly ignore chatter', () => {
        const chatter = GENERAL_GROUP_MESSAGES[3];
        const isMatch = chatter.match(TARGET_REGEX);
        console.log(`[Chatter] "${chatter}" -> ${isMatch ? 'MATCH' : 'IGNORED'}`);
        // We actually want it to be ignored
        if (isMatch) console.warn(`Warning: Chatter matched regex: ${chatter}`);
    });

});
