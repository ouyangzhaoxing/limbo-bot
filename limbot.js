const fs = require('fs');
const jsonfile = require('jsonfile');
const sqlite3 = require('sqlite3').verbose();
const linkify = require('linkify-it')();
const { createClient } = require("oicq");
const { setInterval } = require('timers');

jsonfile.readFile("./config.json", function (err, config) {

  if (err) { console.error(err); return; }

  linkify.tlds(require('tlds'));

  var violationData = new sqlite3.Database("./data.sqlite3"); // 打开数据库（违规数据）

  var bot = createClient(config.bot_id, { log_level: "warn", brief: true, resend: true });

  bot.on("system.login.slider", () => {
    process.stdin.once("data", (input) => bot.sliderLogin(input)); // 滑动验证
  });

  bot.on("system.login.device", () => {
    process.stdin.once("data", () => bot.login()); // 设备锁验证
  });

  bot.on("notice.group.increase", (data) => { //监听群成员加入

    if (!checkListen(data.group_id)) return;

    joinTips(data);
    autoKick(data);
    checkNickname(data);

  });

  var messageHistories = [];

  bot.on("message.group", (data) => { // 监听群组消息

    if (!checkListen(data.group_id)) return;

    messageHistories.push(data); // 缓存历史消息

    if (messageHistories.length > config.cache_msg_max)
      messageHistories.shift();

    if (swordbearerInstruct(data)) return;

    // if (longCodeWithdraw(data)) return;

    answer(data);

    if (data.sender.level >= config.msg_no_check_level) return; // 忽略检查等级较高的成员

    linkWithdraw(data);
    checkMessage(data);

  });

  bot.login(config.password); // 登录

  setTimeout(() => { setInterval(() => { autoTalk(); }, config.auto_talk_interval); }, 10000); // 自动说话

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

  /** 群满自动踢人 */
  function autoKick(data) {
    bot.getGroupInfo(data.group_id).then(function (value) {
      if (value.data.member_count >= value.data.max_member_count - 5) clearGroupMember(data, 10);
    });
  }

  /** 检查昵称是否违规 */
  function checkNickname(data) {

    if (!config.function.banned_name) return;

    let cmd = "SELECT * FROM NAME_BAN_KEY WHERE INSTR($NAME, KEY) > 0;";
    violationData.get(cmd, { $NAME: data.nickname.toUpperCase() }, function (err, row) {

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
    violationData.each(cmd, { $MSG: data.raw_message.toUpperCase() }, function (err, row) {

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

      if ((data.sender.level >= config.no_kick_level && violationValueCount <= 8)
        || data.sender.level == 6) violationValueCount = 5; // 限制踢出群组等级

      let tips = "违规发言";
      let cmd = "INSERT INTO VIOLATION_RECORDS VALUES ($USER_ID, $GROUP_ID, $TYPE, $REMARK, $TIME);";

      if (violationValueCount === 5) { // 禁言

        tips = config.tipsTemplate.banned_message_ban;

        if (config.function.banned_message_gag) bot.setGroupBan(data.group_id, data.user_id, 300);

      }

      else if (violationValueCount > 5) { // 踢出群组

        tips = config.tipsTemplate.banned_message_kick;

        if (config.function.banned_message_kick) bot.setGroupKick(data.group_id, data.user_id);

      }

      if (config.function.banned_message_withdraw) bot.deleteMsg(data.message_id);

      tips = tips.replace("[nickname]", "[CQ:at,qq=" + data.user_id + "]");
      if (config.function.banned_message_tips) bot.sendGroupMsg(data.group_id, tips); // 违规提示

      violationData.run(cmd, {
        $USER_ID: data.user_id, $GROUP_ID: data.group_id,
        $TYPE: violationValueCount > 5 ? "踢出" : "禁言",
        $REMARK: data.raw_message, $TIME: (new Date()).toLocaleString()
      });

    });

  }

  /** 自动应答 */
  function answer(data) {

    let msg = data.message;

    if (!(msg.length >= 2)) return;

    if (!(msg[msg.length - 2].type === "at" && msg[msg.length - 2].data.qq == config.bot_id)) return;
    if (msg[msg.length - 1].type !== "text") return;

    let cmd = msg[msg.length - 1].data.text.split(" ").filter(c => c != "");

    switch (cmd[0]) {

      case "打扫卫生":
        if (data.sender.role === "owner") clearGroupMember(data, parseInt(cmd[1]));
        break;

      default: questionAnswer(data); break;

    }

  }

  /** 判断是否是群主或管理员 */
  function isOwnerOrAdmin(data) {
    return data.sender.role === "owner" || data.sender.role === "admin";
  }

  /** 清理群员 */
  function clearGroupMember(data, num) {

    let lowValueMember = [];

    if (num > 100) num = 100;

    let currentTime = Math.round(new Date() / 1000);

    bot.getGroupMemberList(data.group_id).then(function (value) {

      value.data.forEach((v, k, map) => {

        if (v.level <= 3) {

          // 群员价值
          let mv = ((new Date(v.last_sent_time)) / (60 * 60 * 24)) - (currentTime / (60 * 60 * 24)) + (v.level * 4 - 2);

          lowValueMember.push({ user_id: v.user_id, mv: mv });

        }

      });

      lowValueMember.sort((a, b) => { return a.mv - b.mv; }); // 群员价值排序

      let kickCount = 0, kickFlag = true, cmd = "SELECT * FROM AUTO_KICK_WHITELIST WHERE USER_ID = $USER_ID LIMIT 1;";

      for (let index = 0; index <= num && index < lowValueMember.length; index++) {

        violationData.get(cmd, { $USER_ID: lowValueMember[index].user_id }, function (err, row) {

          kickFlag = true;

          if (row !== undefined && row.EXPIRATION > currentTime) kickFlag = false;

          if (kickFlag) { bot.setGroupKick(data.group_id, lowValueMember[index].user_id); ++kickCount; }

        });

      }

    });

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

  /** 执剑者指令 */
  function swordbearerInstruct(data) {

    let checkFlag = true, msg = data.message;

    if (!(msg.length >= 2)) return;

    if (isOwnerOrAdmin(data) && msg[msg.length - 1].type === "text" &&
      msg[msg.length - 1].data.text.indexOf(config.bot_name) !== -1 &&
      msg[msg.length - 2].type === "at") {

      if (msg[msg.length - 1].data.text.indexOf("击杀") !== -1) swordbearerKill(data);
      else checkFlag = false;

    } else checkFlag = false;

    return checkFlag;

  }

  function swordbearerKill(data) {

    if (data.message[0].type === "reply") {

      bot.getMsg(data.message[0].data.id).then(function (msg) {

        let cmd = "INSERT INTO VIOLATION_RECORDS VALUES ($USER_ID, $GROUP_ID, $TYPE, $REMARK, $TIME);";
        violationData.run(cmd, {
          $USER_ID: msg.data.user_id, $GROUP_ID: msg.data.group_id,
          $TYPE: "击杀", $REMARK: msg.data.raw_message, $TIME: (new Date()).toLocaleString()
        });

      });

    }

    messageHistories.forEach(hmsg => {
      if (hmsg.user_id == data.message[data.message.length - 2].data.qq)
        bot.deleteMsg(hmsg.message_id);
    });

    bot.setGroupKick(data.group_id, data.message[data.message.length - 2].data.qq, true);
    bot.sendGroupMsg(data.group_id, config.tipsTemplate.answer_swordbearer);

  }

  /** 链接撤回 */
  function linkWithdraw(data) {

    if (!config.function.link_withdraw && !linkify.pretest(data.raw_message)) return;

    let cmd = "SELECT * FROM LINK_WHITELIST WHERE INSTR($MSG, VALUE) > 0 LIMIT 1;";

    violationData.get(cmd, { $MSG: data.raw_message }, function (err, row) {

      if (row !== undefined) return;

      bot.deleteMsg(data.message_id);

      bot.sendGroupMsg(data.group_id, config.tipsTemplate.link_withdraw);

    });

  }

  /** 长代码自动撤回 */
  function longCodeWithdraw(data) {

    if (!config.function.long_code_withdraw) return false;

    if (data.raw_message.length > 320 &&
      (data.raw_message.indexOf("#include") !== -1 || data.raw_message.indexOf("public class") !== -1)) {

      bot.deleteMsg(data.message_id);

      bot.sendGroupMsg(data.group_id, "[CQ:at,qq=" + data.user_id + "] 长代码请使用链接分享避免刷屏");
      bot.sendGroupMsg(data.group_id, "https://paste.blinking.fun");

      return true;

    }

    return false;

  }

  /** 自动说话（防封号） */
  function autoTalk() {

    let cmd = "SELECT * FROM AUTO_TALK ORDER BY RANDOM() LIMIT 1;";
    violationData.get(cmd, function (err, row) {

      let index = Math.floor(Math.random() * config.listen.length);
      bot.sendGroupMsg(config.listen[index], row.TEXT);

    });

  }

});
