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
 * Obsidian custom progression dashboard for Pure Tracker data.
 */
class PureTrackerFlowView extends ItemView {
  /**
   * @param {any} leaf
   * @param {PureTrackerPlugin} plugin
   */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.viewState = {
      severity: "ALL",
      blockerLimit: 25,
      statusFilter: "ALL",
      goalSearch: "",
      includeCompleted: true,
      editorGoalId: "",
      editorDraft: null,
    };
    this.modalEl = null;
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
    return "Pure Tracker Progress";
  }

  /**
   * @returns {string}
   */
  getIcon() {
    return "kanban-square";
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
    this.closeGoalModal();
    this.contentEl.empty();
  }

  /**
   * Renders progression board and blocker tables.
   *
   * @returns {Promise<void>}
   */
  async renderGraph() {
    const goals = await this.plugin.readJson("goals.json", { items: [] });
    const quests = await this.plugin.readJson("derived_not_completable_quests.json", { items: [] });
    const diaries = await this.plugin.readJson("derived_not_completable_diaries.json", { items: [] });
    const mapLayout = await this.plugin.readJson("goal_map_layout.json", {
      updatedAt: "",
      positions: {},
    });

    const goalItems = goals.items || [];
    const filteredGoals = this.filterGoals(goalItems);
    const groupedGoals = this.groupGoalsByPhase(filteredGoals);
    const orderedPhases = this.getPhaseOrder(filteredGoals);
    const nextGoal = filteredGoals.find((goal) => !this.isCompleted(goal && goal.status));
    const filteredQuests = this.filterBySeverity(quests.items || []).slice(0, this.viewState.blockerLimit);
    const filteredDiaries = this.filterBySeverity(diaries.items || []).slice(0, this.viewState.blockerLimit);

    this.contentEl.empty();
    this.closeGoalModal();

    const header = this.contentEl.createDiv({ cls: "pure-flow-header" });
    header.createEl("h2", { text: "Pure Tracker Progress Dashboard" });
    header.createEl("p", {
      text: "Track your custom goals by phase, open detailed card modals, and review not-doable lists in clean tables.",
    });

    const controls = this.contentEl.createDiv({ cls: "pure-flow-controls" });
    this.addControlSelect(controls, "Goal Status", ["ALL", "NOT_STARTED", "IN_PROGRESS", "COMPLETED"], this.viewState.statusFilter, (value) => {
      this.viewState.statusFilter = value;
      this.renderGraph();
    });
    this.addControlSelect(
      controls,
      "Blocker Severity",
      ["ALL", "BLOCKED", "RISKY"],
      this.viewState.severity,
      (value) => {
        this.viewState.severity = value;
        this.renderGraph();
      },
    );
    this.addControlSelect(
      controls,
      "Blocker Rows",
      ["10", "25", "50", "100"],
      String(this.viewState.blockerLimit),
      (value) => {
        this.viewState.blockerLimit = Number(value) || 25;
        this.renderGraph();
      },
    );
    this.addGoalSearchControl(controls);
    this.addToggleControl(controls, "Show Completed", this.viewState.includeCompleted, (checked) => {
      this.viewState.includeCompleted = checked;
      this.renderGraph();
    });
    this.addControlButton(controls, "Refresh", async () => {
      await this.renderGraph();
    });
    this.addControlButton(controls, "Open Data Sheets", async () => {
      await this.plugin.openNote("OSRS/Pure Tracker/Data Sheets.md");
    });
    this.addControlButton(controls, "Open Home", async () => {
      await this.plugin.openNote("OSRS/Pure Tracker/Home.md");
    });

    const stats = this.contentEl.createDiv({ cls: "pure-flow-stats" });
    this.addStat(stats, "Total Goals", String(goalItems.length));
    this.addStat(stats, "Visible Goals", String(filteredGoals.length));
    this.addStat(stats, "Quest Blockers", String(filteredQuests.length));
    this.addStat(stats, "Diary Blockers", String(filteredDiaries.length));
    this.addStat(
      stats,
      "Next Goal",
      nextGoal ? `${nextGoal.goalId || "?"} ${nextGoal.goal || ""}`.trim() : "All complete",
    );

    this.renderGoalMaker(filteredGoals);

    const board = this.contentEl.createDiv({ cls: "pure-progress-board" });
    if (orderedPhases.length === 0) {
      board.createEl("p", {
        cls: "pure-flow-empty",
        text: "No goals match current filters.",
      });
    } else {
      for (const phase of orderedPhases) {
        const laneItems = groupedGoals.get(phase) || [];
        const laneDetails = board.createEl("details", { cls: "pure-progress-lane-collapse" });
        laneDetails.open = !this.isPhaseCollapsedByDefault(phase);
        laneDetails.createEl("summary", {
          text: `${phase || "Unspecified Phase"} (${laneItems.length})`,
        });

        const columns = laneDetails.createDiv({ cls: "pure-progress-status-columns" });
        const statusBuckets = [
          { key: "NOT_STARTED", label: "Not Started" },
          { key: "IN_PROGRESS", label: "In Progress" },
          { key: "COMPLETED", label: "Completed" },
        ];
        for (const bucket of statusBuckets) {
          const column = columns.createDiv({ cls: "pure-progress-status-column" });
          const items = laneItems.filter(
            (goal) => this.statusBucket(goal && goal.status) === bucket.key,
          );
          column.createEl("h4", { text: `${bucket.label} (${items.length})` });
          const cards = column.createDiv({ cls: "pure-progress-cards" });
          if (items.length === 0) {
            cards.createEl("p", { cls: "pure-flow-empty", text: "No goals" });
          }
          for (const goal of items) {
            this.createGoalCard(cards, goal, nextGoal && goal === nextGoal, {
              enableModal: true,
            });
          }
        }
      }
    }

    this.renderGoalDependencyMap(filteredGoals, mapLayout);

    const blockerSection = this.contentEl.createDiv({ cls: "pure-blocker-section" });
    blockerSection.createEl("h3", { text: "Not Doable Lists" });
    blockerSection.createEl("p", {
      cls: "pure-progress-lane-meta",
      text: "Shown as tables so they are easy to scan and sort mentally.",
    });
    const questDetails = blockerSection.createEl("details", { cls: "pure-blocker-collapse" });
    questDetails.open = true;
    questDetails.createEl("summary", {
      text: `Not Doable Quests (${filteredQuests.length})`,
    });
    this.renderQuestTable(questDetails, filteredQuests);

    const diaryDetails = blockerSection.createEl("details", { cls: "pure-blocker-collapse" });
    diaryDetails.open = true;
    diaryDetails.createEl("summary", {
      text: `Not Doable Achievement Diaries (${filteredDiaries.length})`,
    });
    this.renderDiaryTable(diaryDetails, filteredDiaries);
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

  addControlButton(container, label, onClick) {
    const button = container.createEl("button", { text: label });
    button.addClass("pure-flow-control-button");
    button.addEventListener("click", async () => {
      await onClick();
    });
  }

  addControlSelect(container, label, options, currentValue, onChange) {
    const wrap = container.createDiv({ cls: "pure-flow-control-group" });
    wrap.createEl("label", { text: label });
    const select = wrap.createEl("select");
    for (const option of options) {
      const optionEl = select.createEl("option", { text: option, value: option });
      optionEl.value = option;
      if (option === currentValue) {
        optionEl.selected = true;
      }
    }
    select.addEventListener("change", () => {
      onChange(select.value);
    });
  }

  /**
   * Adds goal search control.
   *
   * @param {HTMLElement} container
   */
  addGoalSearchControl(container) {
    const wrap = container.createDiv({ cls: "pure-flow-control-group" });
    wrap.createEl("label", { text: "Goal Search" });
    const input = wrap.createEl("input", {
      type: "text",
      value: this.viewState.goalSearch || "",
      placeholder: "Search goal text...",
    });
    input.addClass("pure-flow-control-input");
    input.addEventListener("input", () => {
      this.viewState.goalSearch = input.value || "";
      this.renderGraph();
    });
  }

  /**
   * Adds boolean checkbox control.
   *
   * @param {HTMLElement} container
   * @param {string} label
   * @param {boolean} checked
   * @param {(checked: boolean) => void} onChange
   */
  addToggleControl(container, label, checked, onChange) {
    const wrap = container.createDiv({ cls: "pure-flow-toggle-wrap" });
    const checkbox = wrap.createEl("input", { type: "checkbox" });
    checkbox.checked = !!checked;
    checkbox.addEventListener("change", () => {
      onChange(checkbox.checked);
    });
    wrap.createEl("span", { text: label });
  }

  /**
   * Renders Jira-inspired goal editor and issue list.
   *
   * @param {any[]} goals
   */
  renderGoalMaker(goals) {
    const section = this.contentEl.createDiv({ cls: "pure-goal-maker" });
    section.createEl("h3", { text: "Goal Maker" });
    section.createEl("p", {
      cls: "pure-progress-lane-meta",
      text: "Create/edit goals, manage dependency links, and track dependents in one place.",
    });

    const workspace = section.createDiv({ cls: "pure-goal-maker-workspace" });
    const formPane = workspace.createDiv({ cls: "pure-goal-maker-form" });
    const listPane = workspace.createDiv({ cls: "pure-goal-maker-list" });

    const draft = this.ensureEditorDraft(goals);
    this.renderGoalEditorForm(formPane, draft, goals);
    const issuesDetails = listPane.createEl("details", { cls: "pure-goal-maker-collapse" });
    issuesDetails.open = true;
    issuesDetails.createEl("summary", {
      text: `Goal Issues (${goals.length})`,
    });
    this.renderGoalIssueList(issuesDetails, goals);
  }

  /**
   * Ensures there is an active editor draft.
   *
   * @param {any[]} goals
   * @returns {any}
   */
  ensureEditorDraft(goals) {
    if (this.viewState.editorDraft && this.viewState.editorGoalId) {
      return this.viewState.editorDraft;
    }
    const firstGoal = goals && goals.length > 0 ? goals[0] : null;
    if (firstGoal) {
      this.viewState.editorGoalId = firstGoal.goalId || "";
      this.viewState.editorDraft = this.goalToDraft(firstGoal);
      return this.viewState.editorDraft;
    }
    this.viewState.editorGoalId = "";
    this.viewState.editorDraft = this.createEmptyDraft();
    return this.viewState.editorDraft;
  }

  /**
   * Renders goal form fields and actions.
   *
   * @param {HTMLElement} parent
   * @param {any} draft
   * @param {any[]} goals
   */
  renderGoalEditorForm(parent, draft, goals) {
    const form = parent.createDiv({ cls: "pure-goal-maker-card" });
    form.createEl("h4", {
      text: this.viewState.editorGoalId ? `Edit Goal ${this.viewState.editorGoalId}` : "Create Goal",
    });

    const fields = [
      ["Goal ID", "goalId", "text"],
      ["Phase", "phase", "text"],
      ["Category", "category", "text"],
      ["Goal", "goal", "text"],
      ["Icon URL", "iconUrl", "url"],
      ["Metric", "metric", "text"],
      ["Dependencies (comma-separated goal IDs)", "dependenciesRaw", "text"],
    ];

    for (const field of fields) {
      const label = form.createEl("label", { text: field[0] });
      label.addClass("pure-goal-maker-label");
      const input = form.createEl("input", {
        type: field[2],
        value: String(draft[field[1]] || ""),
      });
      input.addClass("pure-goal-maker-input");
      input.addEventListener("input", () => {
        draft[field[1]] = input.value || "";
      });
    }

    const statusLabel = form.createEl("label", { text: "Status" });
    statusLabel.addClass("pure-goal-maker-label");
    const statusSelect = form.createEl("select");
    statusSelect.addClass("pure-goal-maker-input");
    ["Not Started", "In Progress", "Completed"].forEach((value) => {
      const option = statusSelect.createEl("option", { value: value, text: value });
      if (this.formatStatus(draft.status) === value) {
        option.selected = true;
      }
    });
    statusSelect.addEventListener("change", () => {
      draft.status = statusSelect.value;
    });

    const showInMapWrap = form.createDiv({ cls: "pure-goal-maker-toggle" });
    const showInMapCheckbox = showInMapWrap.createEl("input", { type: "checkbox" });
    showInMapCheckbox.checked = draft.showInMap !== false;
    showInMapWrap.createEl("span", { text: "Show in dependency map" });
    showInMapCheckbox.addEventListener("change", () => {
      draft.showInMap = showInMapCheckbox.checked;
    });

    const notesLabel = form.createEl("label", { text: "Notes" });
    notesLabel.addClass("pure-goal-maker-label");
    const notesArea = form.createEl("textarea", { text: String(draft.notes || "") });
    notesArea.addClass("pure-goal-maker-input");
    notesArea.addClass("pure-goal-maker-notes");
    notesArea.addEventListener("input", () => {
      draft.notes = notesArea.value || "";
    });

    const linkage = form.createDiv({ cls: "pure-goal-linkage" });
    linkage.createEl("h5", { text: "Linkage" });
    const dependencyIds = this.parseDependenciesRaw(draft.dependenciesRaw || "");
    const dependents = this.findDependents(draft.goalId, goals);
    linkage.createEl("p", { text: `Depends on: ${dependencyIds.length ? dependencyIds.join(", ") : "None"}` });
    linkage.createEl("p", { text: `Dependents: ${dependents.length ? dependents.join(", ") : "None"}` });

    const actions = form.createDiv({ cls: "pure-goal-maker-actions" });
    const saveButton = actions.createEl("button", { text: "Save Goal" });
    saveButton.addClass("pure-goal-maker-primary");
    saveButton.addEventListener("click", async () => {
      await this.saveGoalFromDraft(draft);
      await this.renderGraph();
    });

    const newButton = actions.createEl("button", { text: "New Goal" });
    newButton.addEventListener("click", async () => {
      this.viewState.editorGoalId = "";
      this.viewState.editorDraft = this.createEmptyDraft();
      await this.renderGraph();
    });

    if (this.viewState.editorGoalId) {
      const deleteButton = actions.createEl("button", { text: "Delete Goal" });
      deleteButton.addClass("pure-goal-maker-danger");
      deleteButton.addEventListener("click", async () => {
        await this.deleteGoalById(this.viewState.editorGoalId);
        this.viewState.editorGoalId = "";
        this.viewState.editorDraft = this.createEmptyDraft();
        await this.renderGraph();
      });
    }
  }

  /**
   * Renders issue-style goal list with edit actions.
   *
   * @param {HTMLElement} parent
   * @param {any[]} goals
   */
  renderGoalIssueList(parent, goals) {
    const card = parent.createDiv({ cls: "pure-goal-maker-card" });
    card.createEl("h4", { text: "Goal Issues" });
    const table = card.createEl("table", { cls: "pure-goal-issue-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    ["Key", "Summary", "Status", "Links", "Map", "Icon", "Action"].forEach((label) => {
      headRow.createEl("th", { text: label });
    });
    const tbody = table.createEl("tbody");
    for (const goal of goals) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: goal.goalId || "-" });
      row.createEl("td", { text: goal.goal || "-" });
      row.createEl("td", { text: this.formatStatus(goal.status) });
      row.createEl("td", { text: String(this.getGoalDependencies(goal).length) });
      row.createEl("td", { text: this.isGoalShownInMap(goal) ? "Yes" : "No" });
      row.createEl("td", { text: this.normalizeIconUrl(goal.iconUrl) ? "Yes" : "No" });
      const actionCell = row.createEl("td");
      const editButton = actionCell.createEl("button", { text: "Edit" });
      editButton.addEventListener("click", async () => {
        this.viewState.editorGoalId = goal.goalId || "";
        this.viewState.editorDraft = this.goalToDraft(goal);
        await this.renderGraph();
      });
    }
  }

  /**
   * Renders one quest blocker table.
   *
   * @param {HTMLElement} parent
   * @param {any[]} items
   */
  renderQuestTable(parent, items) {
    const wrap = parent.createDiv({ cls: "pure-blocker-table-wrap" });
    wrap.createEl("h4", { text: "Quest Blockers" });
    const table = wrap.createEl("table", { cls: "pure-blocker-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    ["Quest", "Severity", "Reason Code", "Reason"].forEach((header) => {
      headRow.createEl("th", { text: header });
    });
    const tbody = table.createEl("tbody");
    for (const item of items) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: item.quest || "-" });
      row.createEl("td", { text: item.severity || "-" });
      row.createEl("td", { text: item.reasonCode || "-" });
      row.createEl("td", { text: item.riskReason || "-" });
    }
  }

  /**
   * Renders one diary blocker table.
   *
   * @param {HTMLElement} parent
   * @param {any[]} items
   */
  renderDiaryTable(parent, items) {
    const wrap = parent.createDiv({ cls: "pure-blocker-table-wrap" });
    wrap.createEl("h4", { text: "Diary Blockers" });
    const table = wrap.createEl("table", { cls: "pure-blocker-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    ["Diary", "Tier", "Severity", "Reason Code", "Reason"].forEach((header) => {
      headRow.createEl("th", { text: header });
    });
    const tbody = table.createEl("tbody");
    for (const item of items) {
      const row = tbody.createEl("tr");
      row.createEl("td", { text: item.diary || "-" });
      row.createEl("td", { text: item.tier || "-" });
      row.createEl("td", { text: item.severity || "-" });
      row.createEl("td", { text: item.reasonCode || "-" });
      row.createEl("td", { text: item.riskReason || "-" });
    }
  }

  /**
   * Renders a goal-only dependency flowchart.
   *
   * @param {any[]} goals
   * @param {any} mapLayout
   */
  renderGoalDependencyMap(goals, mapLayout) {
    const section = this.contentEl.createDiv({ cls: "pure-goal-flow-section" });
    section.createEl("h3", { text: "Goal Dependency Map" });
    section.createEl("p", {
      cls: "pure-progress-lane-meta",
      text: "Goal cards are linked by dependency goal IDs. Drag cards to reposition and save layout automatically.",
    });

    const visibleGoals = (goals || []).filter((goal) => this.isGoalShownInMap(goal));
    if (!visibleGoals || visibleGoals.length === 0) {
      section.createEl("p", {
        cls: "pure-flow-empty",
        text: "No goals available for dependency mapping. Enable 'Show in map' in Goal Maker.",
      });
      return;
    }

    const viewport = section.createDiv({ cls: "pure-goal-flow-viewport" });
    const canvas = viewport.createDiv({ cls: "pure-goal-flow-canvas" });
    const width = 1400;
    const laneGap = 350;
    const nodeGap = 110;
    const marginX = 40;
    const marginY = 60;

    const phaseOrder = this.getPhaseOrder(visibleGoals);
    const grouped = this.groupGoalsByPhase(visibleGoals);
    let maxLaneCount = 1;
    for (const phase of phaseOrder) {
      const laneItems = grouped.get(phase) || [];
      if (laneItems.length > maxLaneCount) {
        maxLaneCount = laneItems.length;
      }
    }
    const height = Math.max(380, marginY * 2 + (maxLaneCount - 1) * nodeGap + 130);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "pure-goal-flow-links");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    canvas.appendChild(svg);

    const positions = (mapLayout && mapLayout.positions) || {};

    const nodePositionByGoalId = new Map();

    for (let laneIndex = 0; laneIndex < phaseOrder.length; laneIndex++) {
      const phase = phaseOrder[laneIndex];
      const laneItems = grouped.get(phase) || [];
      const x = marginX + laneIndex * laneGap;

      const laneLabel = canvas.createDiv({ cls: "pure-goal-flow-lane-label" });
      laneLabel.setText(phase || "Unspecified Phase");
      laneLabel.style.left = `${x}px`;
      laneLabel.style.top = "12px";

      for (let rowIndex = 0; rowIndex < laneItems.length; rowIndex++) {
        const goal = laneItems[rowIndex];
        const y = marginY + rowIndex * nodeGap;
        const key = this.goalIdKey(goal.goalId);
        const stored = positions[key];
        const useX = stored && typeof stored.x === "number" ? stored.x : x;
        const useY = stored && typeof stored.y === "number" ? stored.y : y;
        nodePositionByGoalId.set(key, { x: useX, y: useY });
        const card = this.createGoalCard(
          canvas,
          goal,
          false,
          {
            enableModal: true,
          },
        );
        card.addClass("pure-goal-flow-node");
        card.style.left = `${useX}px`;
        card.style.top = `${useY}px`;
        this.attachGoalDrag(card, key, canvas, width, height);
      }
    }

    for (const goal of visibleGoals) {
      const toKey = this.goalIdKey(goal.goalId);
      const toPoint = nodePositionByGoalId.get(toKey);
      if (!toPoint) {
        continue;
      }
      const dependencies = this.getGoalDependencies(goal);
      for (const dependencyGoalId of dependencies) {
        const fromPoint = nodePositionByGoalId.get(this.goalIdKey(dependencyGoalId));
        if (!fromPoint) {
          continue;
        }
        this.drawGoalDependencyLink(
          svg,
          fromPoint.x + 260,
          fromPoint.y + 40,
          toPoint.x,
          toPoint.y + 40,
        );
      }
    }
  }

  /**
   * Creates one goal card in progression board.
   *
   * @param {HTMLElement} parent
   * @param {any} goal
   * @param {boolean} isNextGoal
   */
  createGoalCard(parent, goal, isNextGoal, options) {
    const config = Object.assign(
      {
        enableModal: true,
      },
      options || {},
    );
    const status = this.normalizeStatus(goal && goal.status);
    const statusClassKey = this.statusClassKey(status);
    const card = parent.createDiv({
      cls: `pure-goal-card pure-goal-status-${statusClassKey}`,
    });
    if (isNextGoal) {
      card.addClass("is-next-goal");
    }
    card.createEl("div", {
      cls: "pure-goal-card-id",
      text: goal.goalId || "-",
    });
    const iconUrl = this.normalizeIconUrl(goal && goal.iconUrl);
    if (iconUrl) {
      const icon = card.createEl("img", {
        cls: "pure-goal-card-icon",
      });
      icon.src = iconUrl;
      icon.alt = goal.goal || "Goal icon";
      icon.addEventListener("error", () => {
        icon.remove();
      });
    }
    card.createEl("h4", {
      text: goal.goal || "Untitled goal",
    });
    card.createEl("p", {
      text: goal.category || "Uncategorized",
    });
    const meta = card.createDiv({ cls: "pure-goal-card-meta" });
    meta.createEl("span", {
      cls: `pure-goal-status-badge pure-goal-status-badge-${statusClassKey}`,
      text: this.formatStatus(goal.status),
    });
    meta.createEl("span", {
      text: goal.metric || "No metric",
    });
    card.title = goal.notes || "Click for details";
    card.addEventListener("click", (event) => {
      if (card.dataset.dragJustHappened === "1") {
        card.dataset.dragJustHappened = "";
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!config.enableModal) {
        return;
      }
      this.openGoalModal(goal);
    });
    return card;
  }

  /**
   * Opens modal-like overlay for one goal item.
   *
   * @param {any} goal
   */
  openGoalModal(goal) {
    this.closeGoalModal();
    const backdrop = this.contentEl.createDiv({ cls: "pure-goal-modal-backdrop" });
    const modal = backdrop.createDiv({ cls: "pure-goal-modal" });
    const top = modal.createDiv({ cls: "pure-goal-modal-top" });
    top.createEl("h3", { text: goal.goal || "Untitled goal" });
    const closeButton = top.createEl("button", { text: "Close" });
    closeButton.addClass("pure-goal-modal-close");
    closeButton.addEventListener("click", () => {
      this.closeGoalModal();
    });
    modal.createEl("p", { text: `Goal ID: ${goal.goalId || "-"}` });
    modal.createEl("p", { text: `Phase: ${goal.phase || "-"}` });
    modal.createEl("p", { text: `Category: ${goal.category || "-"}` });
    if (this.normalizeIconUrl(goal.iconUrl)) {
      const preview = modal.createEl("img", {
        cls: "pure-goal-modal-icon",
      });
      preview.src = this.normalizeIconUrl(goal.iconUrl);
      preview.alt = goal.goal || "Goal icon";
      preview.addEventListener("error", () => {
        preview.remove();
      });
    }
    modal.createEl("p", { text: `Icon URL: ${goal.iconUrl || "-"}` });
    modal.createEl("p", { text: `Metric: ${goal.metric || "-"}` });
    modal.createEl("p", { text: `Status: ${this.formatStatus(goal.status)}` });
    const dependencyLabel = modal.createEl("label", {
      text: "Dependencies (goal IDs, comma-separated):",
    });
    dependencyLabel.addClass("pure-goal-modal-label");
    const dependencyInput = modal.createEl("input", {
      type: "text",
      value: this.getGoalDependencies(goal).join(", "),
      placeholder: "Example: 12.0, 24.0",
    });
    dependencyInput.addClass("pure-goal-modal-input");
    const showInMapWrap = modal.createDiv({ cls: "pure-goal-modal-toggle" });
    const showInMapCheckbox = showInMapWrap.createEl("input", { type: "checkbox" });
    showInMapCheckbox.checked = this.isGoalShownInMap(goal);
    showInMapWrap.createEl("span", { text: "Show this goal in dependency map" });
    const saveDependenciesButton = modal.createEl("button", { text: "Save Dependencies" });
    saveDependenciesButton.addClass("pure-goal-modal-save");
    saveDependenciesButton.addEventListener("click", async () => {
      const dependencyIds = String(dependencyInput.value || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      await this.saveGoalDependencies(goal.goalId, dependencyIds, showInMapCheckbox.checked);
      this.closeGoalModal();
      await this.renderGraph();
    });
    modal.createEl("p", {
      cls: "pure-goal-modal-notes",
      text: `Notes: ${goal.notes || "No notes provided."}`,
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        this.closeGoalModal();
      }
    });
    this.modalEl = backdrop;
  }

  /**
   * Closes active goal modal.
   */
  closeGoalModal() {
    if (!this.modalEl) {
      return;
    }
    this.modalEl.remove();
    this.modalEl = null;
  }

  /**
   * Extracts dependency IDs from goal object.
   *
   * @param {any} goal
   * @returns {string[]}
   */
  getGoalDependencies(goal) {
    const raw = goal && goal.dependencies;
    if (Array.isArray(raw)) {
      return raw
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0);
    }
    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0);
    }
    return [];
  }

  /**
   * Persists dependency IDs for one goal.
   *
   * @param {string} goalId
   * @param {string[]} dependencyIds
   * @param {boolean} showInMap
   * @returns {Promise<void>}
   */
  async saveGoalDependencies(goalId, dependencyIds, showInMap) {
    const payload = await this.plugin.readJson("goals.json", { source: "", items: [] });
    const targetKey = this.goalIdKey(goalId);
    let updated = false;
    for (const item of payload.items || []) {
      if (this.goalIdKey(item && item.goalId) !== targetKey) {
        continue;
      }
      item.dependencies = dependencyIds.slice();
      item.showInMap = showInMap !== false;
      updated = true;
      break;
    }
    if (!updated) {
      new Notice(`Goal not found for dependency save: ${goalId || "unknown"}`);
      return;
    }
    payload.updatedAt = nowIso();
    await this.plugin.writeJson("goals.json", payload);
    await this.plugin.syncGoalsMarkdown(payload.items || []);
    await this.plugin.appendAudit(
      `Updated dependencies for goal ${goalId || "unknown"} (${dependencyIds.length}).`,
    );
    new Notice("Goal dependencies saved.");
  }

  /**
   * Builds empty editor draft.
   *
   * @returns {any}
   */
  createEmptyDraft() {
    return {
      goalId: "",
      phase: "",
      category: "",
      goal: "",
      metric: "",
      status: "Not Started",
      notes: "",
      dependenciesRaw: "",
      showInMap: true,
      iconUrl: "",
    };
  }

  /**
   * Converts goal object to editable draft shape.
   *
   * @param {any} goal
   * @returns {any}
   */
  goalToDraft(goal) {
    return {
      goalId: String((goal && goal.goalId) || ""),
      phase: String((goal && goal.phase) || ""),
      category: String((goal && goal.category) || ""),
      goal: String((goal && goal.goal) || ""),
      iconUrl: this.normalizeIconUrl(goal && goal.iconUrl),
      metric: String((goal && goal.metric) || ""),
      status: String((goal && goal.status) || "Not Started"),
      notes: String((goal && goal.notes) || ""),
      dependenciesRaw: this.getGoalDependencies(goal).join(", "),
      showInMap: this.isGoalShownInMap(goal),
    };
  }

  /**
   * Parses comma-separated dependency IDs.
   *
   * @param {string} raw
   * @returns {string[]}
   */
  parseDependenciesRaw(raw) {
    return String(raw || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  /**
   * Finds dependent goal IDs for a given goal.
   *
   * @param {string} goalId
   * @param {any[]} goals
   * @returns {string[]}
   */
  findDependents(goalId, goals) {
    const target = this.goalIdKey(goalId);
    if (!target) {
      return [];
    }
    const dependents = [];
    for (const goal of goals || []) {
      const dependencies = this.getGoalDependencies(goal).map((value) => this.goalIdKey(value));
      if (dependencies.indexOf(target) >= 0) {
        dependents.push(goal.goalId || "");
      }
    }
    return dependents;
  }

  /**
   * Saves goal maker draft into goals payload.
   *
   * @param {any} draft
   * @returns {Promise<void>}
   */
  async saveGoalFromDraft(draft) {
    const goalId = String(draft.goalId || "").trim();
    if (!goalId) {
      new Notice("Goal ID is required.");
      return;
    }
    const payload = await this.plugin.readJson("goals.json", { source: "", items: [] });
    const key = this.goalIdKey(goalId);
    const nextItem = {
      goalId: goalId,
      phase: String(draft.phase || "").trim(),
      category: String(draft.category || "").trim(),
      goal: String(draft.goal || "").trim(),
      iconUrl: this.normalizeIconUrl(draft.iconUrl),
      metric: String(draft.metric || "").trim(),
      status: String(draft.status || "Not Started").trim(),
      notes: String(draft.notes || "").trim(),
      dependencies: this.parseDependenciesRaw(draft.dependenciesRaw || ""),
      showInMap: draft.showInMap !== false,
    };

    let updated = false;
    for (let i = 0; i < (payload.items || []).length; i++) {
      const current = payload.items[i];
      if (this.goalIdKey(current && current.goalId) !== key) {
        continue;
      }
      payload.items[i] = nextItem;
      updated = true;
      break;
    }
    if (!updated) {
      payload.items = payload.items || [];
      payload.items.push(nextItem);
    }

    payload.updatedAt = nowIso();
    await this.plugin.writeJson("goals.json", payload);
    await this.plugin.syncGoalsMarkdown(payload.items || []);
    await this.plugin.appendAudit(
      `${updated ? "Updated" : "Created"} goal ${goalId} via Goal Maker.`,
    );
    this.viewState.editorGoalId = goalId;
    this.viewState.editorDraft = this.goalToDraft(nextItem);
    new Notice(`${updated ? "Updated" : "Created"} goal ${goalId}.`);
  }

  /**
   * Deletes one goal by ID.
   *
   * @param {string} goalId
   * @returns {Promise<void>}
   */
  async deleteGoalById(goalId) {
    const key = this.goalIdKey(goalId);
    if (!key) {
      return;
    }
    const payload = await this.plugin.readJson("goals.json", { source: "", items: [] });
    const beforeCount = (payload.items || []).length;
    payload.items = (payload.items || []).filter(
      (item) => this.goalIdKey(item && item.goalId) !== key,
    );
    if (payload.items.length === beforeCount) {
      new Notice(`Goal not found: ${goalId}`);
      return;
    }
    payload.updatedAt = nowIso();
    await this.plugin.writeJson("goals.json", payload);
    await this.plugin.syncGoalsMarkdown(payload.items || []);
    await this.plugin.appendAudit(`Deleted goal ${goalId} via Goal Maker.`);
    new Notice(`Deleted goal ${goalId}.`);
  }

  /**
   * @param {any[]} items
   * @returns {any[]}
   */
  filterBySeverity(items) {
    if (this.viewState.severity === "ALL") {
      return items;
    }
    return items.filter(
      (item) => String(item && item.severity ? item.severity : "").toUpperCase() === this.viewState.severity,
    );
  }

  /**
   * Draws curved link between dependency and dependent goals.
   *
   * @param {SVGElement} svg
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   */
  drawGoalDependencyLink(svg, x1, y1, x2, y2) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const c1x = x1 + Math.max(30, (x2 - x1) * 0.35);
    const c2x = x2 - Math.max(30, (x2 - x1) * 0.35);
    path.setAttribute("d", `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`);
    path.setAttribute("class", "pure-goal-flow-link");
    svg.appendChild(path);
  }

  /**
   * Enables drag movement for a goal node and persists position.
   *
   * @param {HTMLElement} card
   * @param {string} goalKey
   * @param {HTMLElement} canvas
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   */
  attachGoalDrag(card, goalKey, canvas, canvasWidth, canvasHeight) {
    card.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      let dragging = true;
      const rect = card.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      card.classList.add("is-dragging");
      event.preventDefault();

      const onMouseMove = (moveEvent) => {
        if (!dragging) {
          return;
        }
        const canvasRect = canvas.getBoundingClientRect();
        let x = moveEvent.clientX - canvasRect.left - offsetX;
        let y = moveEvent.clientY - canvasRect.top - offsetY;
        x = Math.max(0, Math.min(canvasWidth - 280, x));
        y = Math.max(40, Math.min(canvasHeight - 100, y));
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
      };

      const onMouseUp = async () => {
        if (!dragging) {
          return;
        }
        dragging = false;
        card.classList.remove("is-dragging");
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        const x = Number.parseFloat(card.style.left.replace("px", "")) || 0;
        const y = Number.parseFloat(card.style.top.replace("px", "")) || 0;
        card.dataset.dragJustHappened = "1";
        window.setTimeout(() => {
          if (card && card.dataset) {
            card.dataset.dragJustHappened = "";
          }
        }, 220);
        await this.persistGoalCardPosition(goalKey, x, y);
        await this.renderGraph();
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  /**
   * Saves one dragged goal card position to layout JSON.
   *
   * @param {string} goalKey
   * @param {number} x
   * @param {number} y
   * @returns {Promise<void>}
   */
  async persistGoalCardPosition(goalKey, x, y) {
    if (!goalKey) {
      return;
    }
    const payload = await this.plugin.readJson("goal_map_layout.json", {
      updatedAt: "",
      positions: {},
    });
    payload.positions = payload.positions || {};
    payload.positions[goalKey] = { x: x, y: y };
    payload.updatedAt = nowIso();
    await this.plugin.writeJson("goal_map_layout.json", payload);
  }

  /**
   * Normalizes goal ID to stable comparison key.
   *
   * @param {any} goalId
   * @returns {string}
   */
  goalIdKey(goalId) {
    return String(goalId || "")
      .trim()
      .toLowerCase();
  }

  /**
   * Returns normalized status bucket used for board columns.
   *
   * @param {string} raw
   * @returns {string}
   */
  statusBucket(raw) {
    const status = this.normalizeStatus(raw);
    if (status === "completed" || status === "complete" || status === "done") {
      return "COMPLETED";
    }
    if (status === "in progress" || status === "active" || status === "doing") {
      return "IN_PROGRESS";
    }
    return "NOT_STARTED";
  }

  /**
   * Returns whether a phase should start collapsed by default.
   *
   * @param {string} phase
   * @returns {boolean}
   */
  isPhaseCollapsedByDefault(phase) {
    return this.normalizeName(phase) === "pure start";
  }

  /**
   * Normalizes icon URL value for safe rendering/storage.
   *
   * @param {any} raw
   * @returns {string}
   */
  normalizeIconUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) {
      return "";
    }
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    return "";
  }

  /**
   * Determines whether a goal should render in the map.
   *
   * @param {any} goal
   * @returns {boolean}
   */
  isGoalShownInMap(goal) {
    if (!goal) {
      return false;
    }
    if (goal.showInMap === undefined || goal.showInMap === null) {
      return true;
    }
    if (typeof goal.showInMap === "boolean") {
      return goal.showInMap;
    }
    const normalized = String(goal.showInMap).trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }

  /**
   * Filters goals by controls.
   *
   * @param {any[]} goals
   * @returns {any[]}
   */
  filterGoals(goals) {
    const search = String(this.viewState.goalSearch || "")
      .trim()
      .toLowerCase();
    const filtered = [];
    for (const goal of goals) {
      if (!goal) {
        continue;
      }
      if (!this.viewState.includeCompleted && this.isCompleted(goal.status)) {
        continue;
      }
      if (this.viewState.statusFilter !== "ALL") {
        const status = this.normalizeStatus(goal.status);
        if (this.viewState.statusFilter === "COMPLETED" && status !== "completed" && status !== "complete" && status !== "done") {
          continue;
        }
        if (this.viewState.statusFilter === "IN_PROGRESS" && status !== "in progress" && status !== "active" && status !== "doing") {
          continue;
        }
        if (this.viewState.statusFilter === "NOT_STARTED" && status !== "not started" && status !== "no started" && status !== "todo" && status !== "backlog") {
          continue;
        }
      }
      if (search) {
        const hay = `${goal.goalId || ""} ${goal.phase || ""} ${goal.category || ""} ${goal.goal || ""} ${goal.metric || ""} ${goal.notes || ""}`.toLowerCase();
        if (hay.indexOf(search) === -1) {
          continue;
        }
      }
      filtered.push(goal);
    }
    return filtered;
  }

  /**
   * Groups goals by phase while preserving order.
   *
   * @param {any[]} goals
   * @returns {Map<string, any[]>}
   */
  groupGoalsByPhase(goals) {
    const grouped = new Map();
    for (const goal of goals) {
      const phase = String(goal.phase || "Unspecified Phase").trim() || "Unspecified Phase";
      if (!grouped.has(phase)) {
        grouped.set(phase, []);
      }
      grouped.get(phase).push(goal);
    }
    return grouped;
  }

  /**
   * Returns ordered phase keys from goals.
   *
   * @param {any[]} goals
   * @returns {string[]}
   */
  getPhaseOrder(goals) {
    const seen = new Set();
    const ordered = [];
    for (const goal of goals) {
      const phase = String(goal && goal.phase ? goal.phase : "Unspecified Phase").trim() || "Unspecified Phase";
      if (!seen.has(phase)) {
        seen.add(phase);
        ordered.push(phase);
      }
    }
    return ordered;
  }

  /**
   * @param {string} raw
   * @returns {string}
   */
  formatStatus(raw) {
    const status = this.normalizeStatus(raw);
    if (!status) {
      return "Unspecified";
    }
    if (status === "no started") {
      return "Not Started";
    }
    if (status === "todo") {
      return "Not Started";
    }
    if (status === "in progress") {
      return "In Progress";
    }
    return raw || "Unspecified";
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  normalizeName(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * @param {string} raw
   * @returns {boolean}
   */
  isCompleted(raw) {
    const status = this.normalizeStatus(raw);
    return status === "completed" || status === "complete" || status === "done";
  }

  /**
   * @param {string} raw
   * @returns {string}
   */
  normalizeStatus(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  /**
   * Converts status text into CSS-safe token.
   *
   * @param {string} status
   * @returns {string}
   */
  statusClassKey(status) {
    return String(status || "unknown")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .trim() || "unknown";
  }

  /**
   * Renders blocker tables for not-doable items.
   *
   * @param {HTMLElement} parent
   * @param {any[]} quests
   * @param {any[]} diaries
   */
  renderBlockerTables(parent, quests, diaries) {
    const tables = parent.createDiv({ cls: "pure-blocker-tables" });
    this.renderQuestTable(tables, quests);
    this.renderDiaryTable(tables, diaries);
  }

  /**
   * Adds a section heading.
   *
   * @param {HTMLElement} parent
   * @param {string} text
   */
  addSectionHeading(parent, text) {
    const heading = parent.createDiv({ cls: "pure-section-heading" });
    heading.createEl("h3", { text: text });
  }

  /**
   * Adds legend chips for goal statuses.
   *
   * @param {HTMLElement} parent
   */
  addGoalLegend(parent) {
    const legend = parent.createDiv({ cls: "pure-goal-legend" });
    ["Not Started", "In Progress", "Completed"].forEach((label) => {
      const normalized = this.normalizeStatus(label);
      const statusClassKey = this.statusClassKey(normalized);
      const chip = legend.createDiv({
        cls: `pure-goal-status-badge pure-goal-status-badge-${statusClassKey}`,
      });
      chip.setText(label);
    });
  }

  /**
   * Adds top-level progression content wrapper.
   *
   * @returns {HTMLElement}
   */
  createProgressionWrapper() {
    return this.contentEl.createDiv({ cls: "pure-progress-wrapper" });
  }

  /**
   * Adds goal section metadata.
   *
   * @param {HTMLElement} container
   * @param {number} totalGoals
   */
  addGoalMeta(container, totalGoals) {
    container.createEl("p", {
      cls: "pure-progress-meta",
      text: `Custom goals shown in progression columns (${totalGoals}). Click any card for full details.`,
    });
  }

  /**
   * Adds board header for goals section.
   *
   * @param {HTMLElement} container
   */
  addGoalsHeading(container) {
    const head = container.createDiv({ cls: "pure-progress-head" });
    head.createEl("h3", { text: "Goal Progression Board" });
    this.addGoalLegend(head);
  }

  /**
   * Renders complete goals section.
   *
   * @param {any[]} filteredGoals
   * @param {Map<string, any[]>} groupedGoals
   * @param {string[]} orderedPhases
   */
  renderGoalsSection(filteredGoals, groupedGoals, orderedPhases) {
    const wrap = this.createProgressionWrapper();
    this.addGoalsHeading(wrap);
    this.addGoalMeta(wrap, filteredGoals.length);
    const board = wrap.createDiv({ cls: "pure-progress-board" });
    if (orderedPhases.length === 0) {
      board.createEl("p", {
        cls: "pure-flow-empty",
        text: "No goals match current filters.",
      });
      return;
    }

    for (const phase of orderedPhases) {
      const lane = board.createDiv({ cls: "pure-progress-lane" });
      lane.createEl("h3", { text: phase || "Unspecified Phase" });
      const laneItems = groupedGoals.get(phase) || [];
      lane.createEl("p", {
        cls: "pure-progress-lane-meta",
        text: `${laneItems.length} goals`,
      });
      const cards = lane.createDiv({ cls: "pure-progress-cards" });
      for (const goal of laneItems) {
        this.createGoalCard(cards, goal, false);
      }
    }
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
    await this.ensureFile(
      this.dataPath("goal_map_layout.json"),
      JSON.stringify(
        {
          updatedAt: "",
          positions: {},
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
   * Reads dependency IDs from goal payload item.
   *
   * @param {any} goal
   * @returns {string[]}
   */
  getGoalDependencies(goal) {
    const raw = goal && goal.dependencies;
    if (Array.isArray(raw)) {
      return raw
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0);
    }
    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0);
    }
    return [];
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
      "| Goal ID | Phase | Category | Goal | Icon URL | Metric | Status | Notes | Dependencies | Show In Map |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ];

    for (const item of goals.items || []) {
      lines.push(
        `| ${this.toTableCell(item.goalId)} | ${this.toTableCell(item.phase)} | ${this.toTableCell(item.category)} | ${this.toTableCell(item.goal)} | ${this.toTableCell(this.normalizeIconUrl(item.iconUrl))} | ${this.toTableCell(item.metric)} | ${this.toTableCell(item.status)} | ${this.toTableCell(item.notes)} | ${this.toTableCell(this.getGoalDependencies(item).join(", "))} | ${this.toTableCell(this.isGoalShownInMap(item) ? "true" : "false")} |`,
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
      iconUrl: this.normalizeIconUrl(cells[4]),
      metric: cells[5] || "",
      status: cells[6] || "",
      notes: cells[7] || "",
      dependencies: String(cells[8] || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
      showInMap: (() => {
        const raw = String(cells[9] || "true").trim().toLowerCase();
        return raw === "true" || raw === "1" || raw === "yes";
      })(),
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
      "| Goal ID | Phase | Category | Goal | Icon URL | Metric | Status | Notes | Dependencies | Show In Map |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const goal of items) {
      lines.push(
        `| ${goal.goalId || ""} | ${goal.phase || ""} | ${goal.category || ""} | ${goal.goal || ""} | ${this.normalizeIconUrl(goal.iconUrl)} | ${goal.metric || ""} | ${goal.status || ""} | ${goal.notes || ""} | ${this.getGoalDependencies(goal).join(", ")} | ${this.isGoalShownInMap(goal) ? "true" : "false"} |`,
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

