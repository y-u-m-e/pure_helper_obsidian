const fs = require("fs");
const path = require("path");
const assert = require("assert");
const helpers = require("../pure-core.js");

function run() {
  const questRulesPath =
    "O:\\nexus_workspace\\plugin\\pure_helper\\src\\main\\resources\\quest-filter-rules.json";
  const diaryRulesPath =
    "O:\\nexus_workspace\\plugin\\pure_helper\\src\\main\\resources\\achievement-diary-rules.json";

  const questRoot = JSON.parse(fs.readFileSync(questRulesPath, "utf8"));
  const diaryRoot = JSON.parse(fs.readFileSync(diaryRulesPath, "utf8"));
  const questByName = helpers.indexQuestRules(questRoot.quests || []);
  const questMemo = new Map();

  const constraints = {
    avoidedSkills: ["DEFENCE"],
    skillCaps: { DEFENCE: 1 },
    currentLevels: { DEFENCE: 1 },
    strictness: "STRICT",
    choicePolicy: "ANY_CHOICE_MATCH_IS_RISKY",
  };

  const soulsBane = questByName.get(helpers.normalizeName("A Soul's Bane"));
  assert.ok(soulsBane, "Expected A Soul's Bane rule to exist.");
  const soulsEval = helpers.evaluateQuest(
    soulsBane,
    questByName,
    constraints,
    questMemo,
    new Set(),
  );
  assert.equal(
    soulsEval.risky || soulsEval.locked,
    true,
    "Expected A Soul's Bane to be blocked for 1-def pure.",
  );

  const allQuestResults = [];
  for (const quest of questRoot.quests || []) {
    const evaluation = helpers.evaluateQuest(
      quest,
      questByName,
      constraints,
      questMemo,
      new Set(),
    );
    if (evaluation.risky || evaluation.locked) {
      allQuestResults.push({
        quest: quest.name,
        reason: evaluation.reason,
        reasonCode: evaluation.reasonCode,
      });
    }
  }
  assert.ok(allQuestResults.length > 0, "Expected at least one blocked quest.");

  const allDiaryResults = [];
  for (const diary of diaryRoot.diaries || []) {
    for (const tier of diary.tiers || []) {
      const evaluation = helpers.evaluateDiaryTier(
        diary,
        tier,
        questByName,
        questMemo,
        constraints,
      );
      if (evaluation.blocked) {
        allDiaryResults.push({
          diary: diary.name,
          tier: tier.tier,
          reason: evaluation.reason,
          reasonCode: evaluation.reasonCode,
        });
      }
    }
  }
  assert.ok(allDiaryResults.length > 0, "Expected at least one blocked diary tier.");

  const outDir = path.resolve("O:\\iCloud\\iCloudDrive\\Nexus\\NEXUS\\OSRS\\Pure Tracker\\data");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(outDir, "verification_snapshot.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        blockedQuestCount: allQuestResults.length,
        blockedDiaryTierCount: allDiaryResults.length,
        sampleQuests: allQuestResults.slice(0, 25),
        sampleDiaryTiers: allDiaryResults.slice(0, 25),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `Verified. Blocked quests: ${allQuestResults.length}, blocked diary tiers: ${allDiaryResults.length}`,
  );
}

run();

