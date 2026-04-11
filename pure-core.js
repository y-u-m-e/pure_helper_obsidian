/**
 * Normalizes quest/diary names for lookup keys.
 *
 * @param {string} value
 * @returns {string}
 */
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

/**
 * Normalizes skill names to uppercase.
 *
 * @param {string} skill
 * @returns {string}
 */
function normalizeSkill(skill) {
  return String(skill || "").trim().toUpperCase();
}

/**
 * Returns nested property value safely.
 *
 * @param {any} obj
 * @param {string[]} path
 * @param {any} fallbackValue
 * @returns {any}
 */
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

/**
 * Builds normalized quest index map.
 *
 * @param {any[]} quests
 * @returns {Map<string, any>}
 */
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

/**
 * Determines whether a reward exceeds constraints.
 *
 * @param {string} rewardSkill
 * @param {number} rewardXp
 * @param {any} constraints
 * @returns {boolean}
 */
function rewardExceedsCap(rewardSkill, rewardXp, constraints) {
  var skill = normalizeSkill(rewardSkill);
  var avoidedSkills = getPath(constraints, ["avoidedSkills"], []);
  if (avoidedSkills.indexOf(skill) === -1) {
    return false;
  }

  if (!rewardXp || Number(rewardXp) <= 0) {
    return true;
  }

  var skillCaps = getPath(constraints, ["skillCaps"], {});
  var cap = skillCaps[skill];
  if (cap === undefined || cap === null) {
    return true;
  }

  var currentLevels = getPath(constraints, ["currentLevels"], {});
  var current = Number(currentLevels[skill] !== undefined ? currentLevels[skill] : 1);
  return current >= Number(cap);
}

/**
 * Evaluates risky reward choices.
 *
 * @param {any} choice
 * @param {any} option
 * @param {any} constraints
 * @returns {boolean}
 */
function isChoiceOptionRisky(choice, option, constraints) {
  if (!option) {
    return false;
  }

  var choiceXp = choice && choice.xp ? choice.xp : 0;
  var optionXp = option && option.xp ? option.xp : 0;
  var baseXp = Number(optionXp || choiceXp || 0);
  var count = Number((choice && choice.count) || 1);
  var totalXp = baseXp > 0 ? baseXp * count : baseXp;
  return rewardExceedsCap(option.skill, totalXp, constraints);
}

/**
 * Evaluates skill requirement lock conditions.
 *
 * @param {any} quest
 * @param {any} constraints
 * @returns {{ locked: boolean, reason: string, reasonCode: string }}
 */
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
    var skillCaps = getPath(constraints, ["skillCaps"], {});
    var cap = skillCaps[skill];
    var currentLevels = getPath(constraints, ["currentLevels"], {});
    var current = Number(currentLevels[skill] !== undefined ? currentLevels[skill] : 1);

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

/**
 * Evaluates quest risk recursively.
 *
 * @param {any} quest
 * @param {Map<string, any>} questByName
 * @param {any} constraints
 * @param {Map<string, any>} memo
 * @param {Set<string>} recursionGuard
 * @returns {{ risky: boolean, locked: boolean, reason: string, reasonCode: string }}
 */
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
    var rewardSkill = reward ? reward.skill : "";
    var rewardXp = Number((reward && reward.xp) || 0);
    if (rewardExceedsCap(rewardSkill, rewardXp, constraints)) {
      risky = true;
      reason = "Quest gives avoided-skill XP";
      reasonCode = "FIXED_REWARD_AVOIDED_SKILL_XP";
      break;
    }
  }

  var choicePolicy = getPath(constraints, ["choicePolicy"], "");
  if (!risky && choicePolicy === "ANY_CHOICE_MATCH_IS_RISKY") {
    var choiceRewards = getPath(quest, ["choiceRewards"], []);
    for (var c = 0; c < choiceRewards.length; c++) {
      var choice = choiceRewards[c];
      var options = getPath(choice, ["options"], []);
      var foundRiskyOption = false;
      for (var o = 0; o < options.length; o++) {
        if (isChoiceOptionRisky(choice, options[o], constraints)) {
          foundRiskyOption = true;
          break;
        }
      }
      if (foundRiskyOption) {
        risky = true;
        reason = "Quest choice can award avoided-skill XP";
        reasonCode = "CHOICE_REWARD_AVOIDED_SKILL_XP";
        break;
      }
    }

    var hasUnmodeled = !!getPath(quest, ["flags", "hasUnmodeledChoiceRewards"], false);
    if (!risky && hasUnmodeled) {
      risky = true;
      reason = "Quest has unmodeled choice rewards";
      reasonCode = "UNMODELED_CHOICE_REWARD";
    }
  } else {
    var strictness = getPath(constraints, ["strictness"], "");
    var strictUnmodeled = !!getPath(quest, ["flags", "hasUnmodeledChoiceRewards"], false);
    if (!risky && strictness === "STRICT" && strictUnmodeled) {
      risky = true;
      reason = "Quest has unmodeled choice rewards (strict)";
      reasonCode = "UNMODELED_CHOICE_REWARD";
    }
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

/**
 * Evaluates diary-tier risk.
 *
 * @param {any} diary
 * @param {any} tier
 * @param {Map<string, any>} questByName
 * @param {Map<string, any>} questMemo
 * @param {any} constraints
 * @returns {{ blocked: boolean, reason: string, reasonCode: string, blockedBy: string }}
 */
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
    var rewardSkill = reward ? reward.skill : "";
    var rewardXp = Number((reward && reward.xp) || 0);
    if (rewardExceedsCap(rewardSkill, rewardXp, constraints)) {
      return {
        blocked: true,
        reason: "Diary tier gives avoided-skill XP",
        reasonCode: "DIARY_FIXED_REWARD_AVOIDED_SKILL_XP",
        blockedBy: "",
      };
    }
  }

  var choicePolicy = getPath(constraints, ["choicePolicy"], "");
  if (choicePolicy === "ANY_CHOICE_MATCH_IS_RISKY") {
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

    if (getPath(tier, ["flags", "hasUnmodeledChoiceRewards"], false)) {
      return {
        blocked: true,
        reason: "Diary tier has unmodeled choice rewards",
        reasonCode: "DIARY_UNMODELED_CHOICE_REWARD",
        blockedBy: "",
      };
    }
  } else if (
    getPath(constraints, ["strictness"], "") === "STRICT" &&
    getPath(tier, ["flags", "hasUnmodeledChoiceRewards"], false)
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

module.exports = {
  normalizeName: normalizeName,
  normalizeSkill: normalizeSkill,
  indexQuestRules: indexQuestRules,
  rewardExceedsCap: rewardExceedsCap,
  evaluateQuest: evaluateQuest,
  evaluateDiaryTier: evaluateDiaryTier,
};

