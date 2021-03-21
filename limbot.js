const fs = require('fs');
const jsonfile = require('jsonfile');
const sqlite3 = require('sqlite3').verbose();
const { createClient } = require("oicq");

jsonfile.readFile("./config.json", function (err, config) {

  if (err) { console.error(err); return; }

  var violationData = new sqlite3.Database("./data.sqlite3"); // 打开数据库（违规数据）

  var bot = createClient(config.bot_id, { log_level: "warn" });

  bot.on("system.login.slider", () => {
    process.stdin.once("data", (input) => bot.sliderLogin(input)); // 滑动验证
  });

  bot.on("system.login.device", () => {
    process.stdin.once("data", () => bot.login()); // 设备锁验证
  });

  bot.on("notice.group.increase", (data) => { //监听群成员加入

    if (!checkListen(data.group_id)) return;

    joinTips(data);

    checkNickname(data);

  });

  bot.on("message.group", (data) => { // 监听群组消息

    if (!checkListen(data.group_id)) return;

    answer(data);

    if (data.sender.level >= config.msg_no_check_level) return; // 忽略检查等级较高的成员

    checkMessage(data);

  });

  bot.login(config.password); // 登录

  /*-------------------------------------------------------------------------*/

  /** 检查群组是否需要监听 */
  function checkListen(group_id) {

    for (let index = 0; index < config.listen.length; index++) {
      if (config.listen[index] == group_id) return true;
    }

    return false;

  }

  /** 入群提示 */
  function joinTips(data) {

    if (!config.function.join_tips) return;

    let tips = config.tipsTemplate.join.replace("[nickname]", "[CQ:at,qq=" + data.user_id + "]");
    bot.sendGroupMsg(data.group_id, tips);

  }

  /** 检查昵称是否违规 */
  function checkNickname(data) {

    if (!config.function.banned_name) return;

    let cmd = "SELECT * FROM NAME_BAN_KEY WHERE INSTR($NAME, KEY) > 0;";
    violationData.get(cmd, { $NAME: data.nickname }, function (err, row) {

      if (row === undefined) return;

      bot.setGroupCard(data.group_id, data.user_id, "昵称违规"); // 修改名片

      if (config.function.banned_name_tips) { // 违规提示

        let tips = "昵称违规";

        if (row.EXEC === "BAN") tips = config.tipsTemplate.banned_name_ban;
        else if (row.EXEC === "KICK") tips = config.tipsTemplate.banned_name_kick;

        tips = tips.replace("[nickname]", "[CQ:at,qq=" + data.user_id + "]");

        bot.sendGroupMsg(data.group_id, tips);

      }

      if (config.function.banned_name_kick && row.EXEC === "KICK") // 违规直接踢出群组
        bot.setGroupKick(data.group_id, data.user_id);

    });

  }

  /** 检查消息是否违规 */
  function checkMessage(data) {

    if (!config.function.banned_message) return;

    let violationKeys = {};

    let cmd = "SELECT * FROM MSG_BAN_KEY WHERE INSTR($MSG, KEY) > 0;";
    violationData.each(cmd, { $MSG: data.raw_message }, function (err, row) {

      // 记录违规关键字

      if (!violationKeys.hasOwnProperty(row.GROUP_FLAG))
        violationKeys[row.GROUP_FLAG] = row;

      if (violationKeys[row.GROUP_FLAG].VALUE < row.VALUE)
        violationKeys[row.GROUP_FLAG] = row;

    }, function (err, count) { // 查询完成

      if (count === 0) return; // 不存在违规行为

      let violationValueCount = 0, violationMaxValue = 0; violationType = "违规";

      for (const GROUP_FLAG in violationKeys) { // 计算违规数值和类型

        violationValueCount += violationKeys[GROUP_FLAG].VALUE;

        if (violationKeys[GROUP_FLAG].VALUE > violationMaxValue)
          violationType = violationKeys[GROUP_FLAG].TYPE;

      }

      if (violationValueCount < 5) return; // 未达到违规数值

      let tips = "违规发言";

      if (violationValueCount === 5) { // 禁言
        tips = config.tipsTemplate.banned_message_ban;
        if (config.function.banned_message_gag) bot.setGroupBan(data.group_id, data.user_id, 300);
      }

      else if (violationValueCount > 5) { // 踢出群组
        tips = config.tipsTemplate.banned_message_kick;
        if (config.function.banned_message_kick) bot.setGroupKick(data.group_id, data.user_id);
      }

      if (config.function.banned_message_withdraw && violationValueCount >= 5) // 撤回消息
        bot.deleteMsg(data.message_id);

      tips = tips.replace("[nickname]", "[CQ:at,qq=" + data.user_id + "]");

      if (config.function.banned_message_tips) bot.sendGroupMsg(data.group_id, tips); // 违规提示

    });

  }

  /** 自动应答 */
  function answer(data) {

    if (!(data.message[data.message.length - 2].type === "at" &&
      data.message[data.message.length - 2].data.qq == config.bot_id)) return;

    if (data.message[data.message.length - 1].type !== "text") return;
    let cmd = data.message[data.message.length - 1].data.text.split(" ").filter(c => c != "");

    switch (cmd[0]) {
      // 特殊命令
      default: questionAnswer(data); break;
    }

  }

  /** 问题回答 */
  function questionAnswer(data) {

    if (!config.function.question_answer) return;

    let cmd = "SELECT VALUE FROM QUESTION_ANSWER WHERE KEY = $QUESTION;";
    violationData.get(cmd, { $QUESTION: data.message[data.message.length - 1].data.text.trim() }, function (err, row) {

      if (row === undefined) { bot.sendGroupMsg(data.group_id, config.tipsTemplate.no_answer); return; };

      bot.sendGroupMsg(data.group_id, row.VALUE); // 回答问题

    });

  }

});
