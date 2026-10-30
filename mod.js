/* =====================================================================
 * 奶龙魔改 · 游戏内修改器 mod.js  v2.0
 * ---------------------------------------------------------------------
 * 独立技能系统 + 模式/进度显示
 *  1) 主动技能块(点一下触发, 各自独立 CD)
 *  2) 开关技能块(常驻开关)
 *  3) 参数滑杆块(辅助调整, 与技能无关)
 *  4) 顶部 HUD: 显示当前模式 / 章节 / 波次 / 目标 / 血量 / 能量
 *  5) 底部快捷技能栏: 游戏中可直接点技能
 * 通过 window.__game (Phaser 实例) 拿 battle 场景的 model
 * ===================================================================== */
(function () {
  "use strict";

  var CFG_KEY = "naiwa_mod_cfg_v2";
  var STORE_KEY = "naiwa_skills_store";

  // ---------- 配置默认值 ----------
  var DEFAULT_CFG = {
    // 参数条(辅助)
    heroHP: 1, attackDmg: 1, speedMul: 1, fireRate: 1,
    spawnSpeed: 1, enemyCap: 1, waveSpeed: 1, enemyHpMul: 1,
    bulletCount: 0, bulletStormRate: 12,
    // 开关技能
    autoFire: false, invuln: false, oneShot: false, allSkills: false,
    bulletStorm: false
  };
  // 技能冷却(ms)
  var COOLDOWN = {
    ring: 300,   // 全屏爆发
    rush: 1500,  // 疯狂刷怪
    clear: 400,  // 清屏
    heal: 800,   // 满血+回复能量
    naidan: 2500,// 召唤奶龙
    mega: 2000,  // 全屏核爆
    slow: 1200,  // 时空缓速
    luck: 2000,  // 暴富
    combo: 2500, // 连击风暴
    beef: 1500,  // 肉盾
    storm: 500,  // 风暴toggle(无CD)
    god: 500,
    one: 500,
    autof: 500,
    allsk: 500
  };

  var cfg = loadCfg();
  var cd = {};              // 技能冷却剩余
  var state = { game: null, scene: null, model: null, hooked: false,
    baseHp: 0, panel: null, open: false, hud: null, skillbar: null,
    lastHud: 0, stormState: false };

  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) { var o = JSON.parse(raw); for (var k in DEFAULT_CFG) if (o[k] === undefined) o[k] = DEFAULT_CFG[k]; return o; }
    } catch (e) {}
    var c = {}; for (var k2 in DEFAULT_CFG) c[k2] = DEFAULT_CFG[k2];
    return c;
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }

  // ---------- 取场景/模型 ----------
  function tryBind() {
    var g = window.__game;
    if (!g || !g.scene) return false;
    var sc = null;
    try { sc = g.scene.getScene ? g.scene.getScene("battle") : null; } catch (e) {}
    if (!sc && g.scene.keys) sc = g.scene.keys["battle"];
    if (!sc || !sc.model) return false;
    state.game = g; state.scene = sc; state.model = sc.model;
    if (!state.baseHp) state.baseHp = sc.model.hero ? sc.model.hero.maxHp : 120;
    return true;
  }

  // ---------- 原型 hook ----------
  function hookOnce() {
    if (state.hooked || !state.model) return;
    var m = state.model, P = Object.getPrototypeOf(m);
    state.hooked = true;
    var orig = {
      milkAngles: P.milkAngles, damage: P.damage, spawn: P.spawn,
      progressEndless: P.progressEndless, progressWaves: P.progressWaves,
      offerUpgrade: P.offerUpgrade, update: P.update, attack: P.attack
    };
    state.orig = orig;

    // ① 环形子弹数
    P.milkAngles = function () {
      var base = orig.milkAngles.apply(this, arguments);
      var n = Math.round(cfg.bulletCount);
      if (n > 0) { var arr = base.slice(); for (var i = 0; i < n; i++) arr.push((i / n) * Math.PI * 2 - Math.PI); return arr; }
      return base;
    };
    // ② 伤害倍率 + 一击必杀
    P.damage = function (target, dmg, dir, knock) {
      var d = dmg * (cfg.attackDmg || 1);
      if (cfg.oneShot && target && target.kind !== "hero") d = Math.max(d, target.hp + 99999);
      return orig.damage.call(this, target, d, dir, knock);
    };
    // ③ 敌人血量倍率
    P.spawn = function (kind) {
      var r = orig.spawn.apply(this, arguments);
      if (cfg.enemyHpMul !== 1) {
        for (var i = this.actors.length - 1; i >= 0; i--) {
          var a = this.actors[i];
          if (a && a.kind === kind && a.kind !== "hero") {
            var mul = cfg.enemyHpMul;
            a.maxHp = Math.max(1, Math.round(a.maxHp * mul)); a.hp = a.maxHp;
          }
        }
      }
      return r;
    };
    // ④ 刷怪速度(不改 dt, 压 spawnTimer)
    function patchProgress(origFn) {
      return function (dt) {
        var r = origFn.call(this, dt);
        var speed = Math.max(0.05, cfg.spawnSpeed || 1);
        if (speed > 1 && this.waveRemaining > 0 && this.phase === "playing") {
          var iv = Math.max(0.008, 0.5 / speed);
          if (this.spawnTimer > iv) this.spawnTimer = iv;
        }
        return r;
      };
    }
    if (orig.progressEndless) P.progressEndless = patchProgress(orig.progressEndless);
    if (orig.progressWaves) P.progressWaves = patchProgress(orig.progressWaves);
    // ⑤ update 后实时修正 + HUD
    if (orig.update) {
      P.update = function (dt) {
        var r = orig.update.apply(this, arguments);
        try { applyLiveTweaks(this); } catch (e) {}
        return r;
      };
    }
    // ⑥ 技能全选
    if (orig.offerUpgrade) {
      P.offerUpgrade = function (kind) {
        var r = orig.offerUpgrade.apply(this, arguments);
        if (cfg.allSkills) {
          var self = this;
          setTimeout(function () {
            if (self.phase === "upgrade" && self.pending && self.pending.length) {
              var ids = self.pending.map(function (s) { return s.id; });
              for (var i = 0; i < ids.length; i++) {
                try { if (self.phase === "upgrade" && self.pending.some(function (s) { return s.id === ids[i]; })) self.chooseUpgrade(ids[i]); } catch (e) {}
              }
            }
          }, 60);
        }
        return r;
      };
    }
    // 射速
    if (orig.attack && !P.__nmFire) {
      P.__nmFire = true;
      P.attack = function () {
        var r = orig.attack.apply(this, arguments);
        var fr = Math.max(0.05, cfg.fireRate || 1);
        if (fr !== 1) { this.manualCooldown = Math.max(0.02, this.manualCooldown / fr); this.attackTimer = Math.max(0.02, this.attackTimer / fr); }
        return r;
      };
    }
  }

  // ---------- 每帧实时修正 ----------
  function applyLiveTweaks(m) {
    if (m.config) {
      var C = m.config;
      var wantSpeed = (cfg.speedMul - 1) * 0.5;
      if (Math.abs((C.speedBonus || 0) - wantSpeed) > 0.001) C.speedBonus = wantSpeed;
      var wantDmg = cfg.attackDmg - 1;
      if (Math.abs((C.damageBonus || 0) - wantDmg) > 0.001) C.damageBonus = wantDmg;
      var wantHp = 0;
      if (cfg.heroHP !== 1) wantHp = Math.round(state.baseHp * (cfg.heroHP - 1));
      if (Math.abs((C.healthBonus || 0) - wantHp) > 0.5) {
        C.healthBonus = wantHp;
        if (m.hero) { m.hero.maxHp = Math.max(1, state.baseHp + wantHp); if (m.hero.hp > m.hero.maxHp) m.hero.hp = m.hero.maxHp; }
      }
      var wantProj = Math.max(0, Math.round(cfg.bulletCount));
      if ((C.extraProjectiles || 0) !== wantProj) C.extraProjectiles = wantProj;
      var wantCd = (1 - Math.min(0.9, 1 / Math.max(1, cfg.fireRate))) * 0.5;
      if (Math.abs((C.cooldownBonus || 0) - wantCd) > 0.001) C.cooldownBonus = wantCd;
      var wantMilk = cfg.attackDmg - 1;
      if (Math.abs((C.milkBonus || 0) - wantMilk) > 0.001) C.milkBonus = wantMilk;
    }
    if (m.hero) {
      if (!state.baseHp) state.baseHp = m.hero.maxHp;
      if (cfg.heroHP !== 1) {
        var want = Math.max(1, Math.round(state.baseHp * cfg.heroHP));
        if (m.hero.maxHp !== want) { m.hero.maxHp = want; if (m.hero.hp > want) m.hero.hp = want; }
        if (cfg.heroHP > 1 && m.hero.hp < want) m.hero.hp = want;
      }
    }
    if (cfg.invuln && m.hero) { m.hero.hp = m.hero.maxHp; m.invulnerable = 99; }

    // 波次节奏
    if (cfg.waveSpeed > 1 && m.phase === "playing" && m.nextWaveTimer > 0) {
      var wInt = Math.max(0.05, 1.2 / cfg.waveSpeed);
      if (m.nextWaveTimer > wInt) m.nextWaveTimer = wInt;
    }
    // 刷怪 + 同屏补怪
    if ((cfg.spawnSpeed !== 1 || cfg.enemyCap !== 1) && m.phase === "playing") {
      var alive = 0;
      for (var i = 0; i < m.actors.length; i++) if (!m.actors[i].dead && m.actors[i].kind !== "hero") alive++;
      var base = m.endless ? Math.min(12, 4 + Math.floor(m.wave / 3)) : Math.min(13, 5 + m.zone + m.wave * 2);
      var target = Math.round(base * (cfg.enemyCap || 1));
      if (cfg.spawnSpeed > 1) target = Math.max(target, Math.round(base * 2));
      var want = Math.min(target, Math.min(150, Math.round(alive + 1 + cfg.spawnSpeed * 0.8)));
      if (alive < want) {
        var kinds = ["chaser", "shooter", "jester", "bell", "bomber", "shield"];
        for (var k = alive; k < want; k++) { try { m.spawn(kinds[k % kinds.length]); } catch (e) {} }
      }
    }
    // 自动开火
    if (cfg.autoFire && m.phase === "playing" && m.hero && m.hero.hp > 0) {
      try { m.autoAttack ? m.autoAttack() : m.attack(); } catch (e) {}
    }
    // 子弹风暴
    if (cfg.bulletStorm && m.phase === "playing" && m.hero) {
      var now = performance.now();
      if (!state.lastStorm) state.lastStorm = 0;
      var interval = 1000 / Math.max(1, cfg.bulletStormRate || 12);
      if (now - state.lastStorm >= interval) { state.lastStorm = now; fireRing(m, 24, 900); }
    }
  }

  // ---------- 技能实现 ----------
  function fireRing(m, count, speed) {
    if (!m || !m.hero) return;
    count = count || 24; speed = speed || 900;
    var h = m.hero, dmg = 14 * (cfg.attackDmg || 1);
    for (var i = 0; i < count; i++) {
      var a = (i / count) * Math.PI * 2;
      m.shots.push({ id: ++m.nextId, x: h.x, y: h.y, z: h.z + 70,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, vz: 0,
        life: 2.4, enemy: false, damage: dmg, pierce: 99, hits: new Set(), size: 18 });
    }
    try { m.fx("shoot", h.x, h.y, { z: h.z + 70 }); } catch (e) {}
  }
  // 全屏核爆：全图敌人掉血
  function megaBurst(m) {
    if (!m) return;
    var dmg = Math.max(99999, m.hero ? m.hero.hp : 99999) * (cfg.attackDmg || 1);
    m.actors.forEach(function (a) {
      if (a.kind !== "hero" && !a.dead) { try { m.damage(a, dmg, 0, 1); } catch (e) { a.hp = 0; a.dead = true; } }
    });
    // 清敌方子弹
    m.shots = m.shots.filter(function (s) { return !s.enemy; });
    try { if (m.fx) m.fx("laugh", m.hero.x, m.hero.y, { big: 1 }); } catch (e) {}
  }
  function clearScreen(m) {
    if (!m) return;
    m.actors.forEach(function (a) { if (a.kind !== "hero") { a.hp = 0; a.dead = true; } });
    m.shots = m.shots.filter(function (s) { return !s.enemy; });
  }
  // ---------- 通用技能触发(带CD) ----------
  function skill(name, key, fn, msgs) {
    var now = performance.now();
    if (cd[key] && cd[key] > now) { toastMsg(key + " 冷却中"); return; }
    var m = state.model;
    if (!m) { toastMsg("未进入游戏"); return; }
    fn(m);
    cd[key] = now + (COOLDOWN[key] || 800);
    if (msgs) toastMsg(msgs);
    updateSkillUI();
  }

  function toastMsg(msg) {
    try {
      var t = document.createElement("div");
      t.textContent = msg;
      t.style.cssText = "position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:1000000;" +
        "background:rgba(20,16,34,.96);color:#ffd76a;padding:10px 20px;border-radius:22px;font-size:15px;" +
        "font-family:system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.55);pointer-events:none";
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 1500);
    } catch (e) {}
  }

  // =========================================================
  //  UI
  // =========================================================
  var CSS = [
    "#nm-btn{position:fixed;top:10px;right:10px;z-index:999999;width:44px;height:44px;border-radius:50%;",
    "background:linear-gradient(135deg,#ffd76a,#ff9a3c);border:2px solid #fff3c4;color:#2a1c08;font-size:20px;",
    "font-weight:800;box-shadow:0 3px 12px rgba(0,0,0,.45);cursor:pointer;font-family:system-ui,sans-serif}",
    "#nm-btn:active{transform:scale(.93)}",
    /* 顶部 HUD */
    "#nm-hud{position:fixed;top:0;left:0;right:0;z-index:999990;padding:6px 60px 6px 12px;",
    "background:linear-gradient(180deg,rgba(10,8,20,.72),rgba(10,8,20,.25));color:#eae6f7;",
    "font-family:system-ui,sans-serif;font-size:12px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;",
    "pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.8)}",
    "#nm-hud .mode{color:#ffd76a;font-weight:800}",
    "#nm-hud .hp{color:#7dff9b}#nm-hud .ep{color:#8fd3ff}",
    "#nm-hud .zone{color:#9fd6ff}#nm-hud .obj{color:#cfc9e6}",
    /* 底部快捷技能栏 */
    "#nm-bar{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:999998;",
    "display:flex;gap:7px;padding:6px 9px;border-radius:16px;",
    "background:rgba(16,14,30,.72);box-shadow:0 3px 14px rgba(0,0,0,.45);backdrop-filter:blur(6px)}",
    "#nm-bar .sk{width:52px;height:52px;border-radius:12px;border:1px solid rgba(255,255,255,.18);",
    "background:rgba(255,255,255,.06);color:#fff;font-size:20px;cursor:pointer;position:relative;",
    "font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center}",
    "#nm-bar .sk .cd{position:absolute;inset:0;border-radius:12px;background:rgba(0,0,0,.55);",
    "display:none;align-items:center;justify-content:center;font-size:12px;color:#fff}",
    "#nm-bar .sk.on{background:#7dff9b;color:#142;border-color:#2b6b3a}",
    "#nm-bar .sk .lbl{position:absolute;bottom:-2px;left:0;right:0;font-size:8px;color:#ddd;",
    "text-align:center;line-height:1;text-shadow:0 1px 2px #000}",
    /* 面板 */
    "#nm-panel{position:fixed;top:0;right:0;bottom:0;width:min(86vw,340px);z-index:999999;",
    "background:rgba(16,14,28,.97);color:#eae6f7;overflow-y:auto;padding:14px 14px 60px;",
    "box-shadow:-6px 0 24px rgba(0,0,0,.55);font-family:system-ui,sans-serif;font-size:13px;display:none}",
    "#nm-panel h3{margin:0 0 4px;font-size:17px;color:#ffd76a}",
    "#nm-panel .nm-tabs{display:flex;gap:6px;margin:10px 0 6px}",
    "#nm-panel .nm-tab{flex:1;padding:7px;border:0;border-radius:8px;background:#2a2740;color:#cfc9e6;cursor:pointer;font-size:13px}",
    "#nm-panel .nm-tab.on{background:#ffb347;color:#1b1424;font-weight:800}",
    "#nm-panel .nm-sec{margin:12px 0 4px;font-size:12px;color:#9fd6ff;letter-spacing:1px;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:4px}",
    "#nm-panel .nm-row{display:flex;align-items:center;gap:8px;margin:6px 0}",
    "#nm-panel .nm-row label{flex:0 0 96px;color:#cfc9e6}",
    "#nm-panel .nm-row input[type=range]{flex:1;min-width:0;accent-color:#ffb347}",
    "#nm-panel .nm-row .nm-val{flex:0 0 52px;text-align:right;color:#ffd76a;font-variant-numeric:tabular-nums}",
    "#nm-panel .nm-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}",
    "#nm-panel .nm-b{border:0;border-radius:9px;padding:11px 6px;color:#1b1424;font-weight:700;",
    "background:#ffb347;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif}",
    "#nm-panel .nm-b.nm-alt{background:#8fd3ff}",
    "#nm-panel .nm-b.nm-danger{background:#ff8a8a}",
    "#nm-panel .nm-b.on{background:#7dff9b;box-shadow:0 0 0 2px #2b6b3a inset}",
    "#nm-panel .nm-note{color:#8b86a3;font-size:11px;margin-top:10px;line-height:1.7}",
    "#nm-panel .nm-close{float:right;border:0;background:#3a3550;color:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font-size:15px}"
  ].join("");

  function sliderHTML(key, label, min, max, step) {
    return '<div class="nm-row"><label>' + label + '</label>' +
      '<input type="range" id="nm-s-' + key + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
      '<span class="nm-val" id="nm-v-' + key + '"></span></div>';
  }

  function injectUI() {
    if (document.getElementById("nm-panel")) return;
    var st = document.createElement("style"); st.textContent = CSS;
    document.head.appendChild(st);

    // 顶部按钮
    var btn = document.createElement("button");
    btn.id = "nm-btn"; btn.textContent = "🎛"; btn.title = "奶龙魔改";
    document.body.appendChild(btn);
    btn.onclick = function () { togglePanel(); };

    // 顶部 HUD
    var hud = document.createElement("div"); hud.id = "nm-hud";
    hud.innerHTML = '<span class="mode">—</span><span class="hp">❤ —</span>' +
      '<span class="ep">⚡ —</span><span class="zone">📍 —</span><span class="obj">🎯 —</span>';
    document.body.appendChild(hud); state.hud = hud;

    // 底部快捷技能栏
    var bar = document.createElement("div"); bar.id = "nm-bar";
    document.body.appendChild(bar); state.skillbar = bar;
    buildSkillBar();

    // 面板
    var p = document.createElement("div"); p.id = "nm-panel";
    p.innerHTML =
      '<button class="nm-close" id="nm-x">✕</button>' +
      '<h3>🐸 奶龙魔改 · 技能工坊</h3>' +
      '<div class="nm-tabs">' +
      '  <button class="nm-tab on" id="nm-tab-skill">⚔ 技能</button>' +
      '  <button class="nm-tab" id="nm-tab-switch">🔘 开关</button>' +
      '  <button class="nm-tab" id="nm-tab-param">📈 参数</button>' +
      '</div>' +
      '<div id="nm-view-skill"></div>' +
      '<div id="nm-view-switch" style="display:none"></div>' +
      '<div id="nm-view-param" style="display:none"></div>';
    document.body.appendChild(p); state.panel = p;

    document.getElementById("nm-x").onclick = function () { togglePanel(false); };
    document.getElementById("nm-tab-skill").onclick = function () { showTab('skill'); };
    document.getElementById("nm-tab-switch").onclick = function () { showTab('switch'); };
    document.getElementById("nm-tab-param").onclick = function () { showTab('param'); };

    buildSkillView();
    buildSwitchView();
    buildParamView();
    bindSliders();
  }

  // 技能块定义
  var ACTIVE_SKILLS = [
    { key: 'ring',  icon: '🔥', label: '爆发', name: '全屏子弹爆发', act: fireRing36, cdn: 0.3 },
    { key: 'mega',  icon: '☢️', label: '核爆', name: '全屏核爆', act: actMega, cdn: 2.0 },
    { key: 'clear', icon: '🧹', label: '清屏', name: '清屏', act: actClear, cdn: 0.4 },
    { key: 'heal',  icon: '💚', label: '回血', name: '满血+回能', act: actHeal, cdn: 0.8 },
    { key: 'rush',  icon: '⚡', label: '狂暴', name: '疯狂刷怪', act: actRush, cdn: 1.5 },
    { key: 'naidan',icon: '🐣', label: '奶蛋', name: '召唤奶蛋', act: actNaidan, cdn: 2.5 },
    { key: 'slow',  icon: '🐢', label: '缓速', name: '时空缓速', act: actSlow, cdn: 1.2 },
    { key: 'luck',  icon: '💰', label: '暴富', name: '暴富金币', act: actLuck, cdn: 2.0 },
    { key: 'combo', icon: '🌀', label: '连击', name: '连击风暴', act: actCombo, cdn: 2.5 },
    { key: 'beef',  icon: '🛡️', label: '肉盾', name: '肉盾护甲', act: actBeef, cdn: 1.5 }
  ];
  var SWITCH_SKILLS = [
    { key: 'autoFire', icon: '🤖', label: '自动', name: '自动开火' },
    { key: 'invuln',   icon: '🛡️', label: '无敌', name: '无敌模式' },
    { key: 'oneShot',  icon: '💀', label: '秒杀', name: '一击必杀' },
    { key: 'allSkills',icon: '🃏', label: '全技', name: '技能全选' },
    { key: 'bulletStorm', icon: '🌪️', label: '风暴', name: '子弹风暴' }
  ];

  function buildSkillBar() {
    var bar = state.skillbar; if (!bar) return;
    bar.innerHTML = '';
    var all = ACTIVE_SKILLS.concat(SWITCH_SKILLS.slice(0, 5));
    all.forEach(function (s) {
      var b = document.createElement("button");
      b.className = 'sk'; b.id = 'nm-sk-' + s.key;
      b.innerHTML = s.icon + '<span class="lbl">' + s.label + '</span><span class="cd"></span>';
      b.title = s.name;
      if (ACTIVE_SKILLS.indexOf(s) >= 0) {
        b.onclick = function () { triggerActive(s.key); };
      } else {
        b.onclick = function () { toggleSwitch(s.key); };
      }
      bar.appendChild(b);
    });
  }

  function buildSkillView() {
    var v = document.getElementById("nm-view-skill"); if (!v) return;
    var h = '<div class="nm-sec">🔥 主动技能（点一下触发，各自独立冷却）</div><div class="nm-btns">';
    ACTIVE_SKILLS.forEach(function (s) {
      h += '<button class="nm-b ' + (s.key === 'mega' || s.key === 'clear' ? 'nm-danger' : '') + '" id="nm-p-' + s.key + '">' +
        s.icon + ' ' + s.name + ' <span style="opacity:.55">(' + s.cdn + 's)</span></button>';
    });
    h += '</div><div class="nm-note">💡 底部快捷栏可直接点技能；按住「爆发」可连发。</div>';
    v.innerHTML = h;
    ACTIVE_SKILLS.forEach(function (s) {
      document.getElementById("nm-p-" + s.key).onclick = function () { triggerActive(s.key); };
    });
  }
  function buildSwitchView() {
    var v = document.getElementById("nm-view-switch"); if (!v) return;
    var h = '<div class="nm-sec">🔘 开关技能（常驻，可随时切换）</div><div class="nm-btns">';
    SWITCH_SKILLS.forEach(function (s) {
      h += '<button class="nm-b nm-alt ' + (cfg[s.key] ? 'on' : '') + '" id="nm-sw-' + s.key + '">' +
        s.icon + ' ' + s.name + '</button>';
    });
    h += '</div>';
    v.innerHTML = h;
    SWITCH_SKILLS.forEach(function (s) {
      document.getElementById("nm-sw-" + s.key).onclick = function () { toggleSwitch(s.key); };
    });
  }
  function buildParamView() {
    var v = document.getElementById("nm-view-param"); if (!v) return;
    v.innerHTML =
      '<div class="nm-sec">📈 参数（辅助微调，与技能无关）</div>' +
      sliderHTML('heroHP', '生命上限', 1, 20, 0.1) +
      sliderHTML('attackDmg', '攻击伤害', 0.2, 20, 0.1) +
      sliderHTML('speedMul', '移动速度', 0.2, 5, 0.1) +
      sliderHTML('fireRate', '射速', 0.2, 8, 0.1) +
      sliderHTML('spawnSpeed', '刷怪速度', 0.2, 20, 0.1) +
      sliderHTML('enemyCap', '同屏敌人', 1, 20, 1) +
      sliderHTML('waveSpeed', '波次节奏', 0.2, 10, 0.1) +
      sliderHTML('enemyHpMul', '敌人血量', 0.1, 20, 0.1) +
      sliderHTML('bulletCount', '环形子弹数', 0, 72, 1) +
      '<div class="nm-btns">' +
      '  <button class="nm-b nm-danger" id="nm-resetall">↺ 全部重置</button>' +
      '  <button class="nm-b nm-alt" id="nm-copy">📋 复制配置</button>' +
      '</div>' +
      '<div class="nm-note">💡 「重置」恢复默认参数；「复制」拷贝当前配置到剪贴板。</div>';
    document.getElementById("nm-resetall").onclick = function () {
      for (var k in DEFAULT_CFG) cfg[k] = DEFAULT_CFG[k];
      saveCfg(); syncUI(); toastMsg("↺ 已恢复默认");
    };
    document.getElementById("nm-copy").onclick = function () {
      try { navigator.clipboard.writeText(JSON.stringify(cfg)); toastMsg("📋 已复制"); } catch (e) { toastMsg("复制失败"); }
    };
  }

  function triggerActive(key) {
    var s = ACTIVE_SKILLS.find(function (x) { return x.key === key; });
    if (!s) return;
    var now = performance.now();
    if (cd[key] && cd[key] > now) { toastMsg(s.icon + " " + s.name + " 冷却中"); return; }
    var m = state.model;
    if (!m) { toastMsg("未进入游戏"); return; }
    s.act(m);
    cd[key] = now + COOLDOWN[key];
    toastMsg(s.icon + " " + s.name + "！");
    updateSkillUI();
  }
  function toggleSwitch(key) {
    cfg[key] = !cfg[key];
    saveCfg();
    if (key === 'allSkills' && cfg[key]) { try { applyAllSkillsNow(); } catch (e) {} }
    var el = document.getElementById("nm-sw-" + key); if (el) el.classList.toggle('on', !!cfg[key]);
    var el2 = document.getElementById("nm-sk-" + key); if (el2) el2.classList.toggle('on', !!cfg[key]);
    toastMsg((cfg[key] ? "已开启 " : "已关闭 ") + (SWITCH_SKILLS.find(function(x){return x.key===key})||{}).name);
  }

  // 主动技能动作
  function fireRing36(m) { fireRing(m, 36, 950); }
  function actMega(m) { megaBurst(m); }
  function actClear(m) { clearScreen(m); }
  function actHeal(m) {
    if (m.hero) { m.hero.hp = m.hero.maxHp; }
    m.energy = Math.min(100, (m.energy || 0) + 50);
    try { m.fx("text", m.hero.x, m.hero.y - 60, { text: "+HP +能量", color: 8076987 }); } catch (e) {}
  }
  function actRush(m) {
    cfg.spawnSpeed = 20; cfg.enemyCap = 20; cfg.waveSpeed = 10; saveCfg(); syncUI();
  }
  function actNaidan(m) {
    try { m.summonNaidan(); } catch (e) { try { m.naidanElapsed = 0; } catch (e2) {} }
  }
  function actSlow(m) {
    // 给所有敌人上缓速
    m.actors.forEach(function (a) { if (a.kind !== "hero") { try { a.slowTimer = Math.max(a.slowTimer || 0, 5); a.slowFactor = 0.3; } catch (e) {} } });
    try { m.fx("text", m.hero.x, m.hero.y - 60, { text:"时空缓速", color: 7521535 }); } catch (e) {}
  }
  function actLuck(m) {
    // 直接加金币/补给币
    if (m.runCoins !== undefined) m.runCoins += 50;
    m.kills = (m.kills || 0) + 30;
    try { m.fx("text", m.hero.x, m.hero.y - 60, { text:"暴富 +50", color: 16766720 }); } catch (e) {}
  }
  function actCombo(m) {
    m.combo = Math.max(m.combo || 0, 500);
    if (m.comboMultiplier !== undefined) m.comboMultiplier = 5;
    m.actors.forEach(function (a) { if (a.kind !== "hero") { try { m.damage(a, 30 * (cfg.attackDmg||1), 0, 1); } catch (e) {} } });
    try { m.fx("text", m.hero.x, m.hero.y - 60, { text:"连击风暴", color: 65498 }); } catch (e) {}
  }
  function actBeef(m) {
    if (!m.hero) return;
    m.invulnerable = Math.max(m.invulnerable || 0, 8);
    try { m.fx("text", m.hero.x, m.hero.y - 60, { text:"肉盾护甲", color: 16761024 }); } catch (e) {}
  }

  function applyAllSkillsNow() {
    var m = state.model; if (!m || !m.pending || !m.pending.length) return;
    var ids = m.pending.map(function (s) { return s.id; });
    var applied = 0;
    for (var i = 0; i < ids.length; i++) {
      try {
        if (m.phase === "upgrade" && m.pending.some(function (s) { return s.id === ids[i]; })) {
          m.chooseUpgrade(ids[i]); applied++;
        }
      } catch (e) {}
    }
    if (applied === 0) {
      m.pending.forEach(function (s) {
        if (s.id === "shop-leave" || s.id === "shop-heal" || s.id === "shop-peach") return;
        if (m.upgrades.indexOf(s.id) < 0) m.upgrades.push(s.id);
      });
    }
    toastMsg("🃏 技能已全选");
  }

  // ---------- 进度显示(每帧) ----------
  function updateHUD() {
    if (!state.hud || !state.model) return;
    var m = state.model;
    var h;
    try { h = m.hud(); } catch (e) { return; }
    if (!h) return;
    var mode = m.endless ? "无尽模式" : "冒险模式";
    var zoneTxt = h.zoneName || "";
    var objTxt = h.objective || "";
    var hp = (h.hp !== undefined) ? h.hp + "/" + h.maxHp : "?";
    var ep = (h.energy !== undefined) ? h.energy + "%" : "?";
    // 进度: 章节 x/y
    var prog = "";
    if (!m.endless) {
      var total = 7;
      prog = " 📊 第" + ((h.zone || 0) + 1) + "/" + total + "章";
    } else {
      prog = " 🌊 第" + (h.wave || 1) + "波";
    }
    state.hud.innerHTML =
      '<span class="mode">' + mode + '</span>' +
      '<span class="hp">❤ ' + hp + '</span>' +
      '<span class="ep">⚡ ' + ep + '</span>' +
      '<span class="zone">' + zoneTxt + '</span>' +
      '<span class="obj">🎯 ' + objTxt + '</span>' +
      '<span style="color:#7dff9b">' + prog + '</span>';
  }

  function updateSkillUI() {
    // 冷却圈
    ACTIVE_SKILLS.forEach(function (s) {
      var b = document.getElementById("nm-sk-" + s.key);
      var cdEl = b ? b.querySelector('.cd') : null;
      if (!cdEl) return;
      var left = cd[s.key] - performance.now();
      if (left > 0) {
        cdEl.style.display = 'flex';
        cdEl.textContent = (left / 1000).toFixed(1);
      } else {
        cdEl.style.display = 'none';
      }
    });
  }

  function bindSliders() {
    for (var k in DEFAULT_CFG) {
      if (k === 'autoFire' || k === 'invuln' || k === 'oneShot' || k === 'allSkills' || k === 'bulletStorm') continue;
      (function (key) {
        var sl = document.getElementById("nm-s-" + key);
        var vl = document.getElementById("nm-v-" + key);
        if (!sl) return;
        sl.value = cfg[key];
        if (vl) vl.textContent = fmt(cfg[key]);
        sl.addEventListener("input", function () {
          cfg[key] = parseFloat(sl.value);
          if (vl) vl.textContent = fmt(cfg[key]);
          saveCfg();
          // 立即生效（不等下一帧 update）
          try { if (state.model) applyLiveTweaks(state.model); } catch (e) {}
        });
      })(k);
    }
  }
  function syncUI() {
    SWITCH_SKILLS.forEach(function (s) {
      var el = document.getElementById("nm-sw-" + s.key); if (el) el.classList.toggle('on', !!cfg[s.key]);
      var el2 = document.getElementById("nm-sk-" + s.key); if (el2) el2.classList.toggle('on', !!cfg[s.key]);
    });
    for (var k in DEFAULT_CFG) {
      var sl = document.getElementById("nm-s-" + k); var vl = document.getElementById("nm-v-" + k);
      if (sl) sl.value = cfg[k];
      if (vl) vl.textContent = fmt(cfg[k]);
    }
  }
  function fmt(v) { return (typeof v === "number") ? (Math.round(v * 100) / 100) : v; }
  function showTab(which) {
    ['skill', 'switch', 'param'].forEach(function (t) {
      var tab = document.getElementById("nm-tab-" + t); if (tab) tab.classList.toggle('on', t === which);
      var v = document.getElementById("nm-view-" + t); if (v) v.style.display = (t === which) ? 'block' : 'none';
    });
  }
  function togglePanel(force) {
    if (!state.panel) return;
    state.open = force === undefined ? !state.open : force;
    state.panel.style.display = state.open ? "block" : "none";
    if (state.open) { syncUI(); showTab('skill'); }
  }

  // ---------- 主循环 ----------
  function boot() {
    injectUI();
    state.timer = setInterval(function () {
      if (!state.model) {
        if (tryBind()) { hookOnce(); }
      }
    }, 400);
    setTimeout(function () { if (tryBind()) hookOnce(); }, 600);
    // HUD 循环
    setInterval(function () { updateHUD(); }, 200);
    setInterval(function () { updateSkillUI(); }, 200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();