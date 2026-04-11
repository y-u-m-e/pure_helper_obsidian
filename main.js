const { Plugin, Notice, ItemView } = require("obsidian");

const PURE_TRACKER_FLOW_VIEW_TYPE = "pure-tracker-flow-view";

const DEFAULT_SETTINGS = {
  dataRoot: "OSRS/Pure Tracker/data",
  workbookPath: "C:\\Users\\Karl\\Downloads\\Ironman Pure Progress.xlsx",
  pythonExecutable: "python",
  questRulesPath:
    "O:\\nexus_workspace\\plugin\\pure_helper\\src\\main\\resources\\quest-filter-rules.json",
  diaryRulesPath:
    "O:\\nexus_workspace\\plugin\\pure_helper\\src\\main\\resources\\achievement-diary-rules.json",
  strictness: "STRICT",
  choicePolicy: "SAFE_UNLESS_UNAVOIDABLE",
};

const DEFAULT_CONSTRAINTS = {
  buildProfile: "DEF1_PURE_IRONMAN",
  avoidedSkills: ["DEFENCE"],
  skillCaps: {
    DEFENCE: 1,
  },
  currentLevels: {
    DEFENCE: 1,
  },
  strictness: "STRICT",
  choicePolicy: "SAFE_UNLESS_UNAVOIDABLE",
  ruleVersion: 1,
};

/**
 * Returns ISO timestamp.
 *
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Safely parses JSON and returns fallback if invalid.
 *
 * @param {string} raw
 * @param {any} fallbackValue
 * @returns {any}
 */
function safeJsonParse(raw, fallbackValue) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallbackValue;
  }
}

/**
 * Builds an internal core evaluator module.
 *
 * Why: avoid runtime module-resolution failures for `pure-core.js`.
 *
 * @returns {any}
 */
function loadCore() {
  function normalizeName(value) {
    if (!value) {
      return "";
    }
    return String(value)
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSkill(skill) {
    return String(skill || "").trim().toUpperCase();
  }

  function getPath(obj, path, fallbackValue) {
    var cursor = obj;
    for (var i = 0; i < path.length; i++) {
      if (cursor === null || cursor === undefined) {
        return fallbackValue;
      }
      cursor = cursor[path[i]];
    }
    return cursor === undefined ? fallbackValue : cursor;
  }

  function indexQuestRules(quests) {
    var indexed = new Map();
    var list = quests || [];
    for (var i = 0; i < list.length; i++) {
      var quest = list[i];
      if (!quest || !quest.name) {
        continue;
      }
      indexed.set(normalizeName(quest.name), quest);
    }
    return indexed;
  }

  function rewardExceedsCap(rewardSkill, rewardXp, constraints) {
    var skill = normalizeSkill(rewardSkill);
    var avoidedSkills = getPath(constraints, ["avoidedSkills"], []);
    if (avoidedSkills.indexOf(skill) === -1) {
      return false;
    }
    if (!rewardXp || Number(rewardXp) <= 0) {
      return true;
    }
    var cap = getPath(constraints, ["skillCaps"], {})[skill];
    if (cap === undefined || cap === null) {
      return true;
    }
    var current = Number(getPath(constraints, ["currentLevels"], {})[skill] || 1);
    return current >= Number(cap);
  }

  function isChoiceOptionRisky(choice, option, constraints) {
    if (!option) {
      return false;
    }
    var baseXp = Number((option && option.xp) || (choice && choice.xp) || 0);
    var count = Number((choice && choice.count) || 1);
    var totalXp = baseXp > 0 ? baseXp * count : baseXp;
    return rewardExceedsCap(option.skill, totalXp, constraints);
  }

  function evaluateSkillRequirementRisk(quest, constraints) {
    var requirements = getPath(quest, ["prerequisites", "skills"], []);
    for (var i = 0; i < requirements.length; i++) {
      var requirement = requirements[i];
      var skill = normalizeSkill(requirement && requirement.skill);
      var avoidedSkills = getPath(constraints, ["avoidedSkills"], []);
      if (avoidedSkills.indexOf(skill) === -1) {
        continue;
      }
      var requiredLevel = Number((requirement && requirement.level) || 1);
      var cap = getPath(constraints, ["skillCaps"], {})[skill];
      var current = Number(getPath(constraints, ["currentLevels"], {})[skill] || 1);
      if (cap !== undefined && cap !== null && requiredLevel > Number(cap)) {
        return {
          locked: true,
          reason: "Requires " + skill + " " + requiredLevel + " (cap " + cap + ")",
          reasonCode: "SKILL_REQUIREMENT_EXCEEDS_CAP",
        };
      }
      if ((cap === undefined || cap === null) && requiredLevel > current) {
        return {
          locked: true,
          reason: "Requires " + skill + " " + requiredLevel + " while this skill is protected",
          reasonCode: "SKILL_REQUIREMENT_PROTECTED",
        };
      }
    }
    return { locked: false, reason: "", reasonCode: "NONE" };
  }

  function evaluateQuest(quest, questByName, constraints, memo, recursionGuard) {
    if (!quest) {
      return { risky: false, locked: false, reason: "", reasonCode: "NONE" };
    }

    var key = normalizeName(quest.name);
    if (memo.has(key)) {
      return memo.get(key);
    }
    if (recursionGuard.has(key)) {
      return { risky: false, locked: false, reason: "", reasonCode: "NONE" };
    }

    recursionGuard.add(key);
    var skillReqEval = evaluateSkillRequirementRisk(quest, constraints);
    var risky = false;
    var reason = "";
    var reasonCode = "NONE";
    var locked = !!skillReqEval.locked;
    if (skillReqEval.locked) {
      reason = skillReqEval.reason;
      reasonCode = skillReqEval.reasonCode;
    }

    var fixedRewards = getPath(quest, ["fixedRewards"], []);
    for (var i = 0; i < fixedRewards.length; i++) {
      var reward = fixedRewards[i];
      if (rewardExceedsCap(reward && reward.skill, Number((reward && reward.xp) || 0), constraints)) {
        risky = true;
        reason = "Quest gives avoided-skill XP";
        reasonCode = "FIXED_REWARD_AVOIDED_SKILL_XP";
        break;
      }
    }

    if (!risky && getPath(constraints, ["choicePolicy"], "") === "ANY_CHOICE_MATCH_IS_RISKY") {
      var choiceRewards = getPath(quest, ["choiceRewards"], []);
      for (var c = 0; c < choiceRewards.length; c++) {
        var choice = choiceRewards[c];
        var options = getPath(choice, ["options"], []);
        var foundRisk = false;
        for (var o = 0; o < options.length; o++) {
          if (isChoiceOptionRisky(choice, options[o], constraints)) {
            foundRisk = true;
            break;
          }
        }
        if (foundRisk) {
          risky = true;
          reason = "Quest choice can award avoided-skill XP";
          reasonCode = "CHOICE_REWARD_AVOIDED_SKILL_XP";
          break;
        }
      }

      if (!risky && !!getPath(quest, ["flags", "hasUnmodeledChoiceRewards"], false)) {
        risky = true;
        reason = "Quest has unmodeled choice rewards";
        reasonCode = "UNMODELED_CHOICE_REWARD";
      }
    } else if (
      !risky &&
      getPath(constraints, ["strictness"], "") === "STRICT" &&
      !!getPath(quest, ["flags", "hasUnmodeledChoiceRewards"], false)
    ) {
      risky = true;
      reason = "Quest has unmodeled choice rewards (strict)";
      reasonCode = "UNMODELED_CHOICE_REWARD";
    }

    var prerequisites = getPath(quest, ["prerequisites", "quests"], []);
    for (var p = 0; p < prerequisites.length; p++) {
      var prerequisiteName = prerequisites[p];
      var dependency = questByName.get(normalizeName(prerequisiteName));
      if (!dependency) {
        continue;
      }
      var prerequisiteEval = evaluateQuest(
        dependency,
        questByName,
        constraints,
        memo,
        recursionGuard,
      );
      if (prerequisiteEval.risky || prerequisiteEval.locked) {
        locked = true;
        reason = "Blocked by prerequisite: " + prerequisiteName;
        if (prerequisiteEval.reason) {
          reason += " (" + prerequisiteEval.reason + ")";
        }
        reasonCode = "PREREQUISITE_BLOCKED";
        break;
      }
    }

    recursionGuard.delete(key);
    var result = { risky: risky, locked: locked, reason: reason, reasonCode: reasonCode };
    memo.set(key, result);
    return result;
  }

  function evaluateDiaryTier(diary, tier, questByName, questMemo, constraints) {
    var requiredQuests = getPath(tier, ["requiredQuests"], []);
    for (var i = 0; i < requiredQuests.length; i++) {
      var requiredQuestName = requiredQuests[i];
      var requiredQuest = questByName.get(normalizeName(requiredQuestName));
      if (!requiredQuest) {
        continue;
      }
      var questEval = evaluateQuest(
        requiredQuest,
        questByName,
        constraints,
        questMemo,
        new Set(),
      );
      if (questEval.risky || questEval.locked) {
        return {
          blocked: true,
          reason: "Blocked by prerequisite quest: " + requiredQuestName,
          reasonCode: "DIARY_REQUIRED_QUEST_BLOCKED",
          blockedBy: requiredQuestName,
        };
      }
    }

    var fixedRewards = getPath(tier, ["fixedRewards"], []);
    for (var f = 0; f < fixedRewards.length; f++) {
      var reward = fixedRewards[f];
      if (rewardExceedsCap(reward && reward.skill, Number((reward && reward.xp) || 0), constraints)) {
        return {
          blocked: true,
          reason: "Diary tier gives avoided-skill XP",
          reasonCode: "DIARY_FIXED_REWARD_AVOIDED_SKILL_XP",
          blockedBy: "",
        };
      }
    }

    if (getPath(constraints, ["choicePolicy"], "") === "ANY_CHOICE_MATCH_IS_RISKY") {
      var choiceRewards = getPath(tier, ["choiceRewards"], []);
      for (var c = 0; c < choiceRewards.length; c++) {
        var choice = choiceRewards[c];
        var options = getPath(choice, ["options"], []);
        for (var o = 0; o < options.length; o++) {
          if (isChoiceOptionRisky(choice, options[o], constraints)) {
            return {
              blocked: true,
              reason: "Diary tier choice can award avoided-skill XP",
              reasonCode: "DIARY_CHOICE_REWARD_AVOIDED_SKILL_XP",
              blockedBy: "",
            };
          }
        }
      }
      if (!!getPath(tier, ["flags", "hasUnmodeledChoiceRewards"], false)) {
        return {
          blocked: true,
          reason: "Diary tier has unmodeled choice rewards",
          reasonCode: "DIARY_UNMODELED_CHOICE_REWARD",
          blockedBy: "",
        };
      }
    } else if (
      getPath(constraints, ["strictness"], "") === "STRICT" &&
      !!getPath(tier, ["flags", "hasUnmodeledChoiceRewards"], false)
    ) {
      return {
        blocked: true,
        reason: "Diary tier has unmodeled choice rewards (strict)",
        reasonCode: "DIARY_UNMODELED_CHOICE_REWARD",
        blockedBy: "",
      };
    }

    return {
      blocked: false,
      reason: "",
      reasonCode: "NONE",
      blockedBy: "",
    };
  }

  return {
    normalizeName: normalizeName,
    normalizeSkill: normalizeSkill,
    indexQuestRules: indexQuestRules,
    evaluateQuest: evaluateQuest,
    evaluateDiaryTier: evaluateDiaryTier,
  };
}

/**
 * Loads child_process lazily to avoid startup hard-fail.
 *
 * @returns {(command: string, args?: string[], options?: any) => any}
 */
function loadSpawnSync() {
  return require("child_process").spawnSync;
}

/**
 * Loads fs lazily to avoid startup hard-fail.
 *
 * @returns {any}
 */
function loadFs() {
  return require("fs");
}

/**
 * Obsidian custom graph-like dashboard view for Pure Tracker data.
 */
class PureTrackerFlowView extends ItemView {
  /**
   * @param {any} leaf
   * @param {PureTrackerPlugin} plugin
   */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  /**
   * @returns {string}
   */
  getViewType() {
    return PURE_TRACKER_FLOW_VIEW_TYPE;
  }

  /**
   * @returns {string}
   */
  getDisplayText() {
    return "Pure Tracker Flow";
  }

  /**
   * @returns {string}
   */
  getIcon() {
    return "workflow";
  }

  /**
   * Initializes view and subscribes to tracker data updates.
   *
   * @returns {Promise<void>}
   */
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("pure-flow-view");
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!file || !file.path || !file.path.startsWith(this.plugin.settings.dataRoot)) {
          return;
        }
        if (!file.path.endsWith(".json")) {
          return;
        }
        await this.renderGraph();
      }),
    );
    await this.renderGraph();
  }

  /**
   * Clears custom classes on close.
   *
   * @returns {Promise<void>}
   */
  async onClose() {
    this.contentEl.removeClass("pure-flow-view");
    this.contentEl.empty();
  }

  /**
   * Renders graph-style cards and links from current JSON data.
   *
   * @returns {Promise<void>}
   */
  async renderGraph() {
    const goals = await this.plugin.readJson("goals.json", { items: [] });
    const quests = await this.plugin.readJson("derived_not_completable_quests.json", { items: [] });
    const diaries = await this.plugin.readJson("derived_not_completable_diaries.json", { items: [] });

    const goalItems = goals.items || [];
    const questItems = (quests.items || []).slice(0, 6);
    const diaryItems = (diaries.items || []).slice(0, 6);
    const nextGoal = goalItems.find(
      (goal) => this.normalizeStatus(goal && goal.status) !== "completed",
    );

    const sourceLabel = nextGoal
      ? `${nextGoal.goalId || "?"} - ${nextGoal.goal || "Untitled goal"}`
      : "All goals complete";

    this.contentEl.empty();

    const header = this.contentEl.createDiv({ cls: "pure-flow-header" });
    header.createEl("h2", { text: "Pure Tracker Flow Dashboard" });
    header.createEl("p", {
      text: "Graph-first view for next goal and key blockers. Auto-refreshes on JSON edits.",
    });

    const stats = this.contentEl.createDiv({ cls: "pure-flow-stats" });
    this.addStat(stats, "Goals", String(goalItems.length));
    this.addStat(stats, "Quest Blockers", String(quests.items ? quests.items.length : 0));
    this.addStat(stats, "Diary Blockers", String(diaries.items ? diaries.items.length : 0));

    const graph = this.contentEl.createDiv({ cls: "pure-flow-graph" });
    const sourceNode = graph.createDiv({ cls: "pure-flow-node pure-flow-node-source" });
    sourceNode.createEl("h4", { text: "Next Goal" });
    sourceNode.createEl("p", { text: sourceLabel });
    sourceNode.style.left = "40px";
    sourceNode.style.top = "220px";

    const questTitle = graph.createDiv({ cls: "pure-flow-column-label" });
    questTitle.setText("Quest blockers");
    questTitle.style.left = "400px";
    questTitle.style.top = "12px";

    const diaryTitle = graph.createDiv({ cls: "pure-flow-column-label" });
    diaryTitle.setText("Diary blockers");
    diaryTitle.style.left = "760px";
    diaryTitle.style.top = "12px";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pure-flow-links");
    graph.appendChild(svg);

    const sourceX = 300;
    const sourceY = 265;

    for (let index = 0; index < questItems.length; index++) {
      const item = questItems[index];
      const y = 70 + index * 85;
      const node = graph.createDiv({ cls: "pure-flow-node pure-flow-node-quest" });
      node.createEl("h4", { text: item.quest || "Unknown quest" });
      node.createEl("p", { text: `${item.severity || "UNKNOWN"} - ${item.reasonCode || "UNKNOWN"}` });
      node.style.left = "400px";
      node.style.top = `${y}px`;
      this.drawLink(svg, sourceX, sourceY, 400, y + 30, "quest");
    }

    for (let index = 0; index < diaryItems.length; index++) {
      const item = diaryItems[index];
      const y = 70 + index * 85;
      const node = graph.createDiv({ cls: "pure-flow-node pure-flow-node-diary" });
      node.createEl("h4", { text: `${item.diary || "Unknown diary"} (${item.tier || "?"})` });
      node.createEl("p", { text: `${item.blockedBy || "No prerequisite"} - ${item.reasonCode || "UNKNOWN"}` });
      node.style.left = "760px";
      node.style.top = `${y}px`;
      this.drawLink(svg, sourceX, sourceY, 760, y + 30, "diary");
    }
  }

  /**
   * @param {HTMLElement} container
   * @param {string} label
   * @param {string} value
   */
  addStat(container, label, value) {
    const card = container.createDiv({ cls: "pure-flow-stat" });
    card.createEl("span", { cls: "pure-flow-stat-label", text: label });
    card.createEl("strong", { cls: "pure-flow-stat-value", text: value });
  }

  /**
   * Draws one bezier link in the graph background.
   *
   * @param {SVGElement} svg
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @param {string} type
   */
  drawLink(svg, x1, y1, x2, y2, type) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const c1x = x1 + 80;
    const c2x = x2 - 80;
    path.setAttribute("d", `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`);
    path.setAttribute("class", `pure-flow-link pure-flow-link-${type}`);
    svg.appendChild(path);
  }

  /**
   * @param {string} raw
   * @returns {string}
   */
  normalizeStatus(raw) {
    return String(raw || "").trim().toLowerCase();
  }
}

class PureTrackerPlugin extends Plugin {
  /**
   * Loads plugin state and registers command handlers.
   *
   * @returns {Promise<void>}
   */
  async onload() {
    try {
      await this.loadSettings();
      await this.ensureDataScaffold();
      this.registerView(
        PURE_TRACKER_FLOW_VIEW_TYPE,
        (leaf) => new PureTrackerFlowView(leaf, this),
      );

      this.addRibbonIcon("shield", "Open Pure Tracker Home", async () => {
        await this.safeCall(async () => {
          await this.openNote("OSRS/Pure Tracker/Home.md");
        }, "Open home failed.");
      });

      this.addCommand({
        id: "open-pure-tracker-home",
        name: "Open Pure Tracker Home",
        callback: async () => {
          await this.safeCall(async () => {
            await this.openNote("OSRS/Pure Tracker/Home.md");
          }, "Open home failed.");
        },
      });

      this.addCommand({
        id: "open-pure-tracker-view",
        name: "Open Pure Tracker View",
        callback: async () => {
          await this.safeCall(async () => {
            await this.activateFlowView();
          }, "Open view failed.");
        },
      });

      this.addCommand({
        id: "import-goals-from-workbook",
        name: "Import Goals From Workbook",
        callback: async () => {
          await this.safeCall(async () => {
            await this.importGoalsFromWorkbook();
          }, "Import failed.");
        },
      });

      this.addCommand({
        id: "recompute-not-completable-lists",
        name: "Recompute Not Completable Lists",
        callback: async () => {
          await this.safeCall(async () => {
            await this.recomputeDerivedLists();
          }, "Recompute failed.");
        },
      });

      this.addCommand({
        id: "open-pure-tracker-data-sheets",
        name: "Open Data Sheets",
        callback: async () => {
          await this.safeCall(async () => {
            await this.syncDataSheetsFromJson();
            await this.openNote("OSRS/Pure Tracker/Data Sheets.md");
          }, "Open data sheets failed.");
        },
      });

      this.addCommand({
        id: "refresh-data-sheets-from-json",
        name: "Refresh Data Sheets From JSON",
        callback: async () => {
          await this.safeCall(async () => {
            await this.syncDataSheetsFromJson();
          }, "Refresh data sheets failed.");
        },
      });

      this.addCommand({
        id: "save-data-sheets-to-json",
        name: "Save Data Sheets To JSON",
        callback: async () => {
          await this.safeCall(async () => {
            await this.syncJsonFromDataSheets();
          }, "Save data sheets failed.");
        },
      });

      new Notice("Pure Tracker loaded.");
    } catch (error) {
      console.error("[pure-tracker] onload failed", error);
      new Notice(
        `Pure Tracker failed to load: ${error && error.message ? error.message : "unknown error"}`,
      );
    }
  }

  /**
   * Closes custom leaves on plugin unload.
   *
   * @returns {Promise<void>}
   */
  async onunload() {
    await this.app.workspace.detachLeavesOfType(PURE_TRACKER_FLOW_VIEW_TYPE);
  }

  /**
   * Wraps command execution and surfaces friendly notices.
   *
   * @param {() => Promise<void>} fn
   * @param {string} message
   * @returns {Promise<void>}
   */
  async safeCall(fn, message) {
    try {
      await fn();
    } catch (error) {
      console.error("[pure-tracker] command error", error);
      new Notice(`${message} ${error && error.message ? error.message : ""}`.trim());
    }
  }

  /**
   * Loads plugin settings from persisted state.
   *
   * @returns {Promise<void>}
   */
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  /**
   * Persists plugin settings.
   *
   * @returns {Promise<void>}
   */
  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Builds a file path inside data root.
   *
   * @param {string} fileName
   * @returns {string}
   */
  dataPath(fileName) {
    return `${this.settings.dataRoot}/${fileName}`;
  }

  /**
   * Ensures nested folder path exists.
   *
   * @param {string} folderPath
   * @returns {Promise<void>}
   */
  async ensureFolder(folderPath) {
    const adapter = this.app.vault.adapter;
    const parts = folderPath.split("/").filter((part) => part && part.trim().length > 0);
    let cursor = "";
    for (const part of parts) {
      cursor = cursor ? `${cursor}/${part}` : part;
      // eslint-disable-next-line no-await-in-loop
      const exists = await adapter.exists(cursor);
      if (!exists) {
        // eslint-disable-next-line no-await-in-loop
        await adapter.mkdir(cursor);
      }
    }
  }

  /**
   * Ensures a file exists with seed content.
   *
   * @param {string} filePath
   * @param {string} seed
   * @returns {Promise<void>}
   */
  async ensureFile(filePath, seed) {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(filePath);
    if (!exists) {
      await adapter.write(filePath, seed);
    }
  }

  /**
   * Ensures the plugin note/data scaffold exists.
   *
   * @returns {Promise<void>}
   */
  async ensureDataScaffold() {
    await this.ensureFolder("OSRS");
    await this.ensureFolder("OSRS/Pure Tracker");
    await this.ensureFolder(this.settings.dataRoot);

    await this.ensureFile(
      this.dataPath("goals.json"),
      JSON.stringify({ updatedAt: "", source: "", items: [] }, null, 2),
    );
    await this.ensureFile(
      this.dataPath("constraints.json"),
      JSON.stringify(DEFAULT_CONSTRAINTS, null, 2),
    );
    await this.ensureFile(
      this.dataPath("derived_not_completable_quests.json"),
      JSON.stringify(
        {
          updatedAt: "",
          sourceRules: "",
          constraintsVersion: 1,
          items: [],
        },
        null,
        2,
      ),
    );
    await this.ensureFile(
      this.dataPath("derived_not_completable_diaries.json"),
      JSON.stringify(
        {
          updatedAt: "",
          sourceRules: "",
          constraintsVersion: 1,
          items: [],
        },
        null,
        2,
      ),
    );
    await this.ensureFile(this.dataPath("audit_log.md"), "# Pure Tracker Audit Log\n\n");

    await this.ensureFile(
      "OSRS/Pure Tracker/README.md",
      "# Pure Tracker Index\n\n[[OSRS/Pure Tracker/Home|Home Dashboard]]\n",
    );
    await this.ensureFile(
      "OSRS/Pure Tracker/Home.md",
      "# Pure Tracker Home\n\n[[OSRS/Pure Tracker/README|Pure Tracker Index]]\n",
    );
    await this.ensureFile("OSRS/Pure Tracker/Goals.md", "# Goals\n\n");
    await this.ensureFile(
      "OSRS/Pure Tracker/Not Completable Quests.md",
      "# Not Completable Quests\n\n",
    );
    await this.ensureFile(
      "OSRS/Pure Tracker/Not Completable Diaries.md",
      "# Not Completable Diaries\n\n",
    );
    await this.ensureFile(
      "OSRS/Pure Tracker/Goals Board.md",
      "# Goals Board\n\n[[OSRS/Pure Tracker/README|Pure Tracker Index]]\n",
    );
    await this.ensureFile(
      "OSRS/Pure Tracker/Data Sheets.md",
      "# Data Sheets\n\nUse `Pure Tracker: Refresh Data Sheets From JSON` to populate tables.\n",
    );
  }

  /**
   * Reads data JSON file from vault.
   *
   * @param {string} fileName
   * @param {any} fallbackValue
   * @returns {Promise<any>}
   */
  async readJson(fileName, fallbackValue) {
    const raw = await this.app.vault.adapter.read(this.dataPath(fileName));
    return safeJsonParse(raw, fallbackValue);
  }

  /**
   * Writes data JSON file to vault.
   *
   * @param {string} fileName
   * @param {any} value
   * @returns {Promise<void>}
   */
  async writeJson(fileName, value) {
    await this.app.vault.adapter.write(
      this.dataPath(fileName),
      JSON.stringify(value, null, 2),
    );
  }

  /**
   * Appends one entry to audit log.
   *
   * @param {string} message
   * @returns {Promise<void>}
   */
  async appendAudit(message) {
    await this.app.vault.adapter.append(
      this.dataPath("audit_log.md"),
      `- ${nowIso()} - ${message}\n`,
    );
  }

  /**
   * Opens a note in a fresh leaf.
   *
   * @param {string} notePath
   * @returns {Promise<void>}
   */
  async openNote(notePath) {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!file) {
      new Notice(`Missing note: ${notePath}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  /**
   * Opens or reveals the custom graph dashboard view.
   *
   * @returns {Promise<void>}
   */
  async activateFlowView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(PURE_TRACKER_FLOW_VIEW_TYPE);
    if (existingLeaves.length > 0) {
      await this.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: PURE_TRACKER_FLOW_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Imports goals from workbook using openpyxl.
   *
   * @returns {Promise<void>}
   */
  async importGoalsFromWorkbook() {
    const spawnSync = loadSpawnSync();
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

    const result = spawnSync(
      this.settings.pythonExecutable,
      ["-c", script, this.settings.workbookPath],
      { encoding: "utf8" },
    );
    if (result.error) {
      throw new Error(result.error.message);
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || "python import failed");
    }

    const parsed = safeJsonParse(result.stdout, { items: [] });
    const payload = {
      updatedAt: nowIso(),
      source: this.settings.workbookPath,
      items: parsed.items || [],
    };
    await this.writeJson("goals.json", payload);
    await this.syncGoalsMarkdown(payload.items || []);
    await this.appendAudit(`Imported goals (${payload.items.length}).`);
    new Notice(`Imported ${payload.items.length} goals.`);
  }

  /**
   * Recomputes blocked quest and diary lists from pure-helper rules.
   *
   * @returns {Promise<void>}
   */
  async recomputeDerivedLists() {
    const fs = loadFs();
    const core = loadCore();
    const constraints = await this.readJson("constraints.json", DEFAULT_CONSTRAINTS);
    constraints.avoidedSkills = (constraints.avoidedSkills || []).map(core.normalizeSkill);
    constraints.strictness = constraints.strictness || this.settings.strictness;
    constraints.choicePolicy = constraints.choicePolicy || this.settings.choicePolicy;

    const questRoot = safeJsonParse(
      fs.readFileSync(this.settings.questRulesPath, "utf8"),
      { quests: [] },
    );
    const diaryRoot = safeJsonParse(
      fs.readFileSync(this.settings.diaryRulesPath, "utf8"),
      { diaries: [] },
    );
    const questByName = core.indexQuestRules(questRoot.quests || []);
    const questMemo = new Map();

    const blockedQuests = [];
    for (const quest of questRoot.quests || []) {
      const evaluation = core.evaluateQuest(
        quest,
        questByName,
        constraints,
        questMemo,
        new Set(),
      );
      if (evaluation.risky || evaluation.locked) {
        blockedQuests.push({
          ruleId: quest.id || core.normalizeName(quest.name),
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
        const evaluation = core.evaluateDiaryTier(
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
          ruleId: `${diary.id || core.normalizeName(diary.name)}_${tier.tier || "UNKNOWN"}`,
          diary: diary.name,
          tier: tier.tier || "UNKNOWN",
          blockedBy: evaluation.blockedBy || "",
          riskReason: evaluation.reason || "Blocked by build safeguards",
          reasonCode: evaluation.reasonCode || "UNKNOWN",
          severity: "BLOCKED",
        });
      }
    }

    await this.writeJson("derived_not_completable_quests.json", {
      updatedAt: nowIso(),
      sourceRules: this.settings.questRulesPath,
      constraintsVersion: constraints.ruleVersion || 1,
      items: blockedQuests,
    });
    await this.writeJson("derived_not_completable_diaries.json", {
      updatedAt: nowIso(),
      sourceRules: this.settings.diaryRulesPath,
      constraintsVersion: constraints.ruleVersion || 1,
      items: blockedDiaries,
    });

    await this.syncQuestMarkdown(blockedQuests);
    await this.syncDiaryMarkdown(blockedDiaries);
    await this.appendAudit(
      `Recomputed exclusions (quests: ${blockedQuests.length}, diaries: ${blockedDiaries.length}).`,
    );
    new Notice(
      `Recomputed exclusions: ${blockedQuests.length} quests, ${blockedDiaries.length} diary tiers.`,
    );
  }

  /**
   * Escapes one markdown table cell value.
   *
   * @param {any} value
   * @returns {string}
   */
  toTableCell(value) {
    return String(value || "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ")
      .trim();
  }

  /**
   * Extracts one markdown section body by heading title.
   *
   * @param {string} raw
   * @param {string} heading
   * @returns {string}
   */
  extractSection(raw, heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`## ${escapedHeading}\\n([\\s\\S]*?)(\\n## |$)`, "m");
    const match = raw.match(pattern);
    if (!match) {
      return "";
    }
    return match[1].trim();
  }

  /**
   * Parses markdown table rows from a section.
   *
   * @param {string} section
   * @returns {string[][]}
   */
  parseTableRows(section) {
    const lines = section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"));
    if (lines.length < 2) {
      return [];
    }
    const rows = [];
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line === "|") {
        continue;
      }
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.replace(/\\\|/g, "|").trim());
      if (cells.every((cell) => !cell)) {
        continue;
      }
      rows.push(cells);
    }
    return rows;
  }

  /**
   * Writes an editable pseudo-spreadsheet note from JSON payloads.
   *
   * @returns {Promise<void>}
   */
  async syncDataSheetsFromJson() {
    const goals = await this.readJson("goals.json", { items: [] });
    const quests = await this.readJson("derived_not_completable_quests.json", { items: [] });
    const diaries = await this.readJson("derived_not_completable_diaries.json", { items: [] });

    const lines = [
      "# Data Sheets",
      "",
      "[[OSRS/Pure Tracker/Home|Pure Tracker Home]] | [[OSRS/Pure Tracker/README|Pure Tracker Index]]",
      "",
      "> [!info] Pseudo Excel Editor",
      "> - Edit rows directly in these tables.",
      "> - Run `Pure Tracker: Save Data Sheets To JSON` to persist your edits.",
      "> - Run `Pure Tracker: Refresh Data Sheets From JSON` to discard note edits and reload from JSON.",
      "",
      "## Goals (goals.json)",
      "",
      "| Goal ID | Phase | Category | Goal | Metric | Status | Notes |",
      "|---|---|---|---|---|---|---|",
    ];

    for (const item of goals.items || []) {
      lines.push(
        `| ${this.toTableCell(item.goalId)} | ${this.toTableCell(item.phase)} | ${this.toTableCell(item.category)} | ${this.toTableCell(item.goal)} | ${this.toTableCell(item.metric)} | ${this.toTableCell(item.status)} | ${this.toTableCell(item.notes)} |`,
      );
    }

    lines.push(
      "",
      "## Quest Blockers (derived_not_completable_quests.json)",
      "",
      "| Rule ID | Quest | Blocked By | Severity | Reason Code | Reason |",
      "|---|---|---|---|---|---|",
    );

    for (const item of quests.items || []) {
      lines.push(
        `| ${this.toTableCell(item.ruleId)} | ${this.toTableCell(item.quest)} | ${this.toTableCell(item.blockedBy)} | ${this.toTableCell(item.severity)} | ${this.toTableCell(item.reasonCode)} | ${this.toTableCell(item.riskReason)} |`,
      );
    }

    lines.push(
      "",
      "## Diary Blockers (derived_not_completable_diaries.json)",
      "",
      "| Rule ID | Diary | Tier | Blocked By | Severity | Reason Code | Reason |",
      "|---|---|---|---|---|---|---|",
    );

    for (const item of diaries.items || []) {
      lines.push(
        `| ${this.toTableCell(item.ruleId)} | ${this.toTableCell(item.diary)} | ${this.toTableCell(item.tier)} | ${this.toTableCell(item.blockedBy)} | ${this.toTableCell(item.severity)} | ${this.toTableCell(item.reasonCode)} | ${this.toTableCell(item.riskReason)} |`,
      );
    }

    lines.push("", "#pure-tracker #data-sheets #pseudo-excel");
    await this.app.vault.adapter.write("OSRS/Pure Tracker/Data Sheets.md", lines.join("\n"));
    await this.appendAudit("Refreshed data sheets from JSON.");
    new Notice("Data Sheets refreshed from JSON.");
  }

  /**
   * Parses Data Sheets note and writes rows back to JSON files.
   *
   * @returns {Promise<void>}
   */
  async syncJsonFromDataSheets() {
    const dataSheetsPath = "OSRS/Pure Tracker/Data Sheets.md";
    const exists = await this.app.vault.adapter.exists(dataSheetsPath);
    if (!exists) {
      throw new Error("Data Sheets note is missing.");
    }

    const raw = await this.app.vault.adapter.read(dataSheetsPath);
    const goalsSection = this.extractSection(raw, "Goals (goals.json)");
    const questsSection = this.extractSection(raw, "Quest Blockers (derived_not_completable_quests.json)");
    const diariesSection = this.extractSection(raw, "Diary Blockers (derived_not_completable_diaries.json)");

    const goalRows = this.parseTableRows(goalsSection);
    const questRows = this.parseTableRows(questsSection);
    const diaryRows = this.parseTableRows(diariesSection);

    const goalsItems = goalRows.map((cells) => ({
      goalId: cells[0] || "",
      phase: cells[1] || "",
      category: cells[2] || "",
      goal: cells[3] || "",
      metric: cells[4] || "",
      status: cells[5] || "",
      notes: cells[6] || "",
    }));

    const questItems = questRows.map((cells) => ({
      ruleId: cells[0] || "",
      quest: cells[1] || "",
      blockedBy: cells[2] || "",
      severity: cells[3] || "",
      reasonCode: cells[4] || "",
      riskReason: cells[5] || "",
    }));

    const diaryItems = diaryRows.map((cells) => ({
      ruleId: cells[0] || "",
      diary: cells[1] || "",
      tier: cells[2] || "",
      blockedBy: cells[3] || "",
      severity: cells[4] || "",
      reasonCode: cells[5] || "",
      riskReason: cells[6] || "",
    }));

    const goalsPayload = await this.readJson("goals.json", { source: "", items: [] });
    const questsPayload = await this.readJson("derived_not_completable_quests.json", {
      sourceRules: "",
      constraintsVersion: 1,
      items: [],
    });
    const diariesPayload = await this.readJson("derived_not_completable_diaries.json", {
      sourceRules: "",
      constraintsVersion: 1,
      items: [],
    });

    goalsPayload.updatedAt = nowIso();
    goalsPayload.items = goalsItems;
    questsPayload.updatedAt = nowIso();
    questsPayload.items = questItems;
    diariesPayload.updatedAt = nowIso();
    diariesPayload.items = diaryItems;

    await this.writeJson("goals.json", goalsPayload);
    await this.writeJson("derived_not_completable_quests.json", questsPayload);
    await this.writeJson("derived_not_completable_diaries.json", diariesPayload);

    await this.syncGoalsMarkdown(goalsItems);
    await this.syncQuestMarkdown(questItems);
    await this.syncDiaryMarkdown(diaryItems);
    await this.appendAudit(
      `Saved data sheets to JSON (goals: ${goalsItems.length}, quests: ${questItems.length}, diaries: ${diaryItems.length}).`,
    );
    new Notice("Saved Data Sheets to JSON.");
  }

  /**
   * Writes goals table note.
   *
   * @param {any[]} items
   * @returns {Promise<void>}
   */
  async syncGoalsMarkdown(items) {
    const lines = [
      "# Goals",
      "",
      "[[OSRS/Pure Tracker/README|Pure Tracker Index]]",
      "",
      "| Goal ID | Phase | Category | Goal | Metric | Status | Notes |",
      "|---|---|---|---|---|---|---|",
    ];
    for (const goal of items) {
      lines.push(
        `| ${goal.goalId || ""} | ${goal.phase || ""} | ${goal.category || ""} | ${goal.goal || ""} | ${goal.metric || ""} | ${goal.status || ""} | ${goal.notes || ""} |`,
      );
    }
    lines.push("", "#pure-tracker #goals");
    await this.app.vault.adapter.write("OSRS/Pure Tracker/Goals.md", lines.join("\n"));
  }

  /**
   * Writes quest blockers table note.
   *
   * @param {any[]} items
   * @returns {Promise<void>}
   */
  async syncQuestMarkdown(items) {
    const lines = [
      "# Not Completable Quests",
      "",
      "[[OSRS/Pure Tracker/README|Pure Tracker Index]]",
      "",
      "| Quest | Severity | Reason | Rule ID |",
      "|---|---|---|---|",
    ];
    for (const item of items) {
      lines.push(
        `| ${item.quest || ""} | ${item.severity || ""} | ${item.riskReason || ""} | ${item.ruleId || ""} |`,
      );
    }
    lines.push("", "#pure-tracker #quests #not-completable");
    await this.app.vault.adapter.write(
      "OSRS/Pure Tracker/Not Completable Quests.md",
      lines.join("\n"),
    );
  }

  /**
   * Writes diary blockers table note.
   *
   * @param {any[]} items
   * @returns {Promise<void>}
   */
  async syncDiaryMarkdown(items) {
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
        `| ${item.diary || ""} | ${item.tier || ""} | ${item.severity || ""} | ${item.riskReason || ""} | ${item.ruleId || ""} |`,
      );
    }
    lines.push("", "#pure-tracker #diaries #not-completable");
    await this.app.vault.adapter.write(
      "OSRS/Pure Tracker/Not Completable Diaries.md",
      lines.join("\n"),
    );
  }
}

module.exports = PureTrackerPlugin;

