const fs = require('fs');
const jsonfile = require('jsonfile');
const { createClient } = require("oicq");

jsonfile.readFile("./config.json", function (err, config) {

  if (err) { console.error(err); return; }

  var bot = createClient(config.bot_id, { log_level: "warn" });

  bot.on("system.login.slider", () => {
    process.stdin.once("data", (input) => bot.sliderLogin(input)); // 滑动验证
  });

  bot.on("system.login.device", () => {
    process.stdin.once("data", () => bot.login()); // 设备锁验证
  });

  bot.login(config.password); // 登录

});
