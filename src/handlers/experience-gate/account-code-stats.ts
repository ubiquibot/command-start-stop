import { Context } from "../../types";
import { statsParser, topLangsParser } from "./parsers";

export async function accountCodeStats(context: Context) {
    const { payload, logger, config: { experience: { languages, mostImportantLanguage, statThresholds } } } = context;
    const { sender } = payload;

    const { langs, stats } = await getAccountStats(sender.login);

    if (!handleLanguageChecks(langs, mostImportantLanguage, languages, logger, sender)) {
        return;
    }

    if (!handleStatChecks(stats, statThresholds, logger, sender)) {
        return;
    }

    return true;
}


async function getAccountStats(username: string) {
    // https://github.com/anuraghazra/github-readme-stats - for more info, filters, etc.
    const statsUrl = `https://github-readme-stats.vercel.app/api?username=${username}`;
    const topLangsUrl = `https://github-readme-stats.vercel.app/api/top-langs/?username=${username}`

    const statsRes = await fetch(statsUrl);
    const topLangsRes = await fetch(topLangsUrl);

    const statsDoc = await statsRes.text();
    const topLangsDoc = await topLangsRes.text();

    return {
        stats: statsParser(statsDoc),
        langs: topLangsParser(topLangsDoc)
    }
}

function handleLanguageChecks(
    langs: { lang: string; percentage: number }[],
    mostImportantLanguage: Context["config"]["experience"]["mostImportantLanguage"],
    languages: Context["config"]["experience"]["languages"],
    logger: Context["logger"],
    sender: Context["payload"]["sender"]
) {
    const mostImportantLang = Object.keys(mostImportantLanguage)[0].toLowerCase();
    const requiredMilThreshold = Object.values(mostImportantLanguage)[0];
    const mostImportantLangData = langs.find(lang => lang.lang.toLowerCase() === mostImportantLang);

    if (!mostImportantLangData) {
        logger.error(`${sender.login} does not any recorded experience with ${mostImportantLanguage}`);
        return;
    }

    if (mostImportantLangData.percentage < requiredMilThreshold) {
        logger.error(`${sender.login} has less than required ${requiredMilThreshold}% experience with ${mostImportantLangData.lang}`);
        return;
    }

    const langsToCheck = Object.keys(languages).map(lang => lang.toLowerCase());
    const detectedLangs = [];
    for (const lang of langsToCheck) {
        const langData = langs.find(l => l.lang.toLowerCase() === lang);
        if (langData) {
            detectedLangs.push(langData);
        }
    }

    for (const lang of detectedLangs) {
        const threshold = languages[lang.lang.toLowerCase()];
        const percentage = lang.percentage;

        console.log(`processing ${lang.lang} with ${percentage}% experience`);

        if (threshold > percentage) {
            logger.error(`${sender.login}: ${percentage}% of ${lang.lang} is less than required ${threshold}%`);
            return;
        }
    }



    logger.info(`${sender.login} has passed all language checks`);

    return true;
}

function handleStatChecks(
    stats: ReturnType<typeof statsParser>,
    thresholds: Context["config"]["experience"]["statThresholds"],
    logger: Context["logger"],
    sender: Context["payload"]["sender"]
) {
    const {
        totalPRs,
        totalStars,
        totalIssues,
        totalCommitsThisYear,
    } = stats;

    if (totalPRs < thresholds.prs) {
        logger.error(`${sender.login} has less than required ${thresholds.prs} PRs`);
        return;
    }

    if (totalStars < thresholds.stars) {
        logger.error(`${sender.login} has less than required ${thresholds.stars} stars`);
        return;
    }

    if (totalIssues < thresholds.issues) {
        logger.error(`${sender.login} has less than required ${thresholds.issues} issues`);
        return;
    }

    if (totalCommitsThisYear < thresholds.minCommitsThisYear) {
        logger.error(`${sender.login} has less than required ${thresholds.minCommitsThisYear} commits`);
        return;
    }

    logger.info(`${sender.login} has passed all stat checks`);

    return true;
}
