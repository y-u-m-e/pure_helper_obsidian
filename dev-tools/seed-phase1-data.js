const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const helpers = require("../pure-core.js");

const WORKBOOK_PATH = "C:\\Users\\Karl\\Downloads\\Ironman Pure Progress.xlsx";
const PYTHON_EXE = "python";
const QUEST_RULES_PATH =
  "O:\\nexus_workspace\\plugin\\pure_helper\\src\\main\\resources\\quest-filter-rules.json";
const DIARY_RULES_PATH =
  "O:\\nexus_workspace\\plugin\\pure_helper\\src\\main\\resources\\achievement-diary-rules.json";
const ROOT = "O:\\iCloud\\iCloudDrive\\Nexus\\NEXUS\\OSRS\\Pure Tracker";
const DATA_DIR = path.join(ROOT, "data");

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function importGoals() {
  const script = [
    "import json, sys, openpyxl",
    "wb=openpyxl.load_workbook(sys.argv[1], data_only=True)",
    "ws=wb['Goals']",
    "items=[]",
    "for row in ws.iter_rows(min_row=2, values_only=True):",
    "  goal_id, phase, category, goal, metric, status, notes = row[:7]",
    "  if not goal and not category and not metric:",
    "    continue",
    "  items.append({",
    "    'goalId': str(goal_id or '').strip(),",
    "    'phase': str(phase or '').strip(),",
    "    'category': str(category or '').strip(),",
    "    'goal': str(goal or '').strip(),",
    "    'metric': str(metric or '').strip(),",
    "    'status': str(status or '').strip(),",
    "    'notes': str(notes or '').strip()",
    "  })",
    "print(json.dumps({'items': items}))",
  ].join("\n");
  const result = spawnSync(PYTHON_EXE, ["-c", script, WORKBOOK_PATH], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Goal import failed: ${result.stderr || "unknown error"}`);
  }
  return JSON.parse(result.stdout).items || [];
}

function writeGoalsMarkdown(goals) {
  const lines = [
    "# Goals",
    "",
    "[[OSRS/Pure Tracker/README|Pure Tracker Index]]",
    "",
    "| Goal ID | Phase | Category | Goal | Metric | Status | Notes |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const goal of goals) {
    lines.push(
      `| ${goal.goalId || ""} | ${goal.phase || ""} | ${goal.category || ""} | ${
        goal.goal || ""
      } | ${goal.metric || ""} | ${goal.status || ""} | ${goal.notes || ""} |`,
    );
  }
  lines.push("", "#pure-tracker #goals");
  fs.writeFileSync(path.join(ROOT, "Goals.md"), lines.join("\n"), "utf8");
}

function writeQuestMarkdown(items) {
  const lines = [
    "# Not Completable Quests",
    "",
    "[[OSRS/Pure Tracker/README|Pure Tracker Index]]",
    "",
    "| Quest | Severity | Reason | Rule ID |",
    "|---|---|---|---|",
  ];
  for (const item of items) {
    lines.push(`| ${item.quest} | ${item.severity} | ${item.riskReason} | ${item.ruleId} |`);
  }
  lines.push("", "#pure-tracker #quests #not-completable");
  fs.writeFileSync(path.join(ROOT, "Not Completable Quests.md"), lines.join("\n"), "utf8");
}

function writeDiaryMarkdown(items) {
  const lines = [
    "# Not Completable Diaries",
    "",
    "[[OSRS/Pure Tracker/README|Pure Tracker Index]]",
    "",
    "| Diary | Tier | Severity | Reason | Rule ID |",
    "|---|---|---|---|---|",
  ];
  for (const item of items) {
    lines.push(
      `| ${item.diary} | ${item.tier} | ${item.severity} | ${item.riskReason} | ${item.ruleId} |`,
    );
  }
  lines.push("", "#pure-tracker #diaries #not-completable");
  fs.writeFileSync(path.join(ROOT, "Not Completable Diaries.md"), lines.join("\n"), "utf8");
}

function run() {
  ensureDirectories();
  const constraints = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, "constraints.json"), "utf8"),
  );
  constraints.avoidedSkills = (constraints.avoidedSkills || []).map(helpers.normalizeSkill);
  const questRoot = JSON.parse(fs.readFileSync(QUEST_RULES_PATH, "utf8"));
  const diaryRoot = JSON.parse(fs.readFileSync(DIARY_RULES_PATH, "utf8"));
  const questByName = helpers.indexQuestRules(questRoot.quests || []);
  const questMemo = new Map();

  const goals = importGoals();
  fs.writeFileSync(
    path.join(DATA_DIR, "goals.json"),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        source: WORKBOOK_PATH,
        items: goals,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeGoalsMarkdown(goals);

  const blockedQuests = [];
  for (const quest of questRoot.quests || []) {
    const evaluation = helpers.evaluateQuest(
      quest,
      questByName,
      constraints,
      questMemo,
      new Set(),
    );
    if (evaluation.risky || evaluation.locked) {
      blockedQuests.push({
        ruleId: quest.id || helpers.normalizeName(quest.name),
        quest: quest.name,
        blockedBy: evaluation.reasonCode === "PREREQUISITE_BLOCKED" ? "PREREQUISITE" : "",
        riskReason: evaluation.reason || "Blocked by build safeguards",
        reasonCode: evaluation.reasonCode || "UNKNOWN",
        severity: evaluation.locked ? "BLOCKED" : "RISKY",
      });
    }
  }

  const blockedDiaries = [];
  for (const diary of diaryRoot.diaries || []) {
    for (const tier of diary.tiers || []) {
      const evaluation = helpers.evaluateDiaryTier(
        diary,
        tier,
        questByName,
        questMemo,
        constraints,
      );
      if (!evaluation.blocked) {
        continue;
      }
      blockedDiaries.push({
        ruleId: `${diary.id || helpers.normalizeName(diary.name)}_${tier.tier || "UNKNOWN"}`,
        diary: diary.name,
        tier: tier.tier || "UNKNOWN",
        blockedBy: evaluation.blockedBy || "",
        riskReason: evaluation.reason || "Blocked by build safeguards",
        reasonCode: evaluation.reasonCode || "UNKNOWN",
        severity: "BLOCKED",
      });
    }
  }

  fs.writeFileSync(
    path.join(DATA_DIR, "derived_not_completable_quests.json"),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        sourceRules: QUEST_RULES_PATH,
        constraintsVersion: constraints.ruleVersion || 1,
        items: blockedQuests,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "derived_not_completable_diaries.json"),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        sourceRules: DIARY_RULES_PATH,
        constraintsVersion: constraints.ruleVersion || 1,
        items: blockedDiaries,
      },
      null,
      2,
    ),
    "utf8",
  );

  writeQuestMarkdown(blockedQuests);
  writeDiaryMarkdown(blockedDiaries);

  fs.appendFileSync(
    path.join(DATA_DIR, "audit_log.md"),
    `- ${new Date().toISOString()} - Seeded phase-1 data (goals: ${goals.length}, quests: ${blockedQuests.length}, diaries: ${blockedDiaries.length})\n`,
    "utf8",
  );

  console.log(
    `Seed complete. goals=${goals.length}, blockedQuests=${blockedQuests.length}, blockedDiaryTiers=${blockedDiaries.length}`,
  );
}

run();

