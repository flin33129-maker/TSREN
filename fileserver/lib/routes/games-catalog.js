'use strict';

/**
 * P1 游戏中心 · 合规游戏目录（自动生成，勿手改）。
 * 数据源：r15/srv/public-games/catalog.json + build_mirror.py 的树哈希/体积。
 * 生成时间：2026-10-22 14:01:04+0800
 */

module.exports = {
  "generatedAt": "2026-10-22 14:01:04+0800",
  "categories": [
    {
      "id": "all",
      "label": "全部"
    },
    {
      "id": "puzzle",
      "label": "益智"
    },
    {
      "id": "logic",
      "label": "逻辑"
    },
    {
      "id": "arcade",
      "label": "街机"
    },
    {
      "id": "racing",
      "label": "竞速"
    },
    {
      "id": "action",
      "label": "动作"
    },
    {
      "id": "music",
      "label": "音乐"
    },
    {
      "id": "adventure",
      "label": "冒险"
    },
    {
      "id": "idle",
      "label": "放置"
    }
  ],
  "games": [
    {
      "id": "2048",
      "name": "2048 数字合并",
      "nameEn": "2048",
      "category": "puzzle",
      "tags": [
        "滑动",
        "合并",
        "键盘/触屏"
      ],
      "desc": "把相同数字方块合并成 2048。规则极简、单手可玩，原作者 Gabriele Cirulli 以 MIT 协议开源。",
      "author": "Gabriele Cirulli",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/gabrielecirulli/2048/blob/master/LICENSE.txt",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2014 Gabriele Cirulli"
      },
      "source": {
        "repo": "gabrielecirulli/2048",
        "url": "https://github.com/gabrielecirulli/2048",
        "version": "478b6ec (2024-10-24)",
        "date": "2024-10-24"
      },
      "version": "20241024",
      "entry": "index.html",
      "treeHash": "52475ea4e02bcfa57de52c59bfe6fd549de33f8c90e6208895d4d74881e71f90",
      "sizeBytes": 609741,
      "fileCount": 36,
      "modifications": [
        "保留上游 LICENSE 原文（LICENSE.txt）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "adarkroom",
      "name": "小黑屋",
      "nameEn": "A Dark Room",
      "category": "adventure",
      "tags": [
        "文字",
        "生存",
        "经营"
      ],
      "desc": "从一堆篝火开始的极简文字生存/经营游戏：生火、狩猎、建造村庄，直到走出小黑屋。MPL-2.0 开源。",
      "author": "Doublespeak Games（Michael Townsend）",
      "license": {
        "spdx": "MPL-2.0",
        "name": "Mozilla Public License 2.0",
        "url": "https://github.com/doublespeakgames/adarkroom/blob/main/LICENSE.md",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) Doublespeak Games"
      },
      "source": {
        "repo": "doublespeakgames/adarkroom",
        "url": "https://github.com/doublespeakgames/adarkroom",
        "version": "1fada46 (2025-05-23)",
        "date": "2025-05-23"
      },
      "version": "20250523",
      "entry": "index.html",
      "treeHash": "61e01288b423f96d4fb52b5e7850ac46716996ecb63dd55bf4e250383c2c5258",
      "sizeBytes": 10403676,
      "fileCount": 231,
      "modifications": [
        "移除外部 jQuery（改用仓库自带 lib/jquery.min.js）：<script src=\"https://ajax.googleapis.com/ajax/libs/jquery/1.10.1/jquery.min.js\"></script>",
        "Google Tag Manager 外链 → 本地空桩 vendor/offline-empty.js",
        "保留上游 LICENSE 原文（LICENSE.md）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "astray",
      "name": "迷途迷宫",
      "nameEn": "Astray",
      "category": "action",
      "tags": [
        "WebGL",
        "3D",
        "迷宫"
      ],
      "desc": "Three.js + Box2D 的 3D 迷宫：滚动小球穿过墙壁迷宫，找到出口。作者以 Unlicense 放到公有领域。",
      "author": "wwwtyro",
      "license": {
        "spdx": "Unlicense",
        "name": "The Unlicense（公有领域）",
        "url": "https://github.com/wwwtyro/Astray/blob/master/License.md",
        "commercial": true,
        "shareAlike": false,
        "notice": "This is free and unencumbered software released into the public domain."
      },
      "source": {
        "repo": "wwwtyro/Astray",
        "url": "https://github.com/wwwtyro/Astray",
        "version": "d3c4f61 (2022-08-13)",
        "date": "2022-08-13"
      },
      "version": "20220813",
      "entry": "index.html",
      "treeHash": "bf164c2823613f4d5f215c7441078ec238df4ff4cbf36d3cba54246549a53978",
      "sizeBytes": 1627321,
      "fileCount": 14,
      "modifications": [
        "纹理绝对路径 /xxx.png → 相对路径（部署在 /games/astray/ 子目录，绝对路径会 404）",
        "保留上游 LICENSE 原文（LICENSE.md）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "beatrix",
      "name": "鼓点节拍",
      "nameEn": "Beatrix",
      "category": "music",
      "tags": [
        "音乐",
        "节奏",
        "Phaser"
      ],
      "desc": "把鼓块摆到节奏线上，跟着节拍敲出正确鼓点。Phaser 引擎，MIT 协议。",
      "author": "Cong（cxong）",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/cxong/Beatrix/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2014 Cong"
      },
      "source": {
        "repo": "cxong/Beatrix",
        "url": "https://github.com/cxong/Beatrix",
        "version": "059b74a (2018-05-12)",
        "date": "2018-05-12"
      },
      "version": "20180512",
      "entry": "index.html",
      "treeHash": "4ac2101261873028ee761a331fd456ae5aec6961f010fb3a2fd4bb1c0c04e4d6",
      "sizeBytes": 1078311,
      "fileCount": 90,
      "modifications": [
        "保留上游 LICENSE 原文（LICENSE）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "stp-flood",
      "name": "洪水填色",
      "nameEn": "Flood",
      "category": "arcade",
      "tags": [
        "填色",
        "策略",
        "步数限制"
      ],
      "desc": "从左上角开始扩散颜色，在限定步数内把整张网格染成同一种颜色。Simon Tatham 谜题集（2026 版），MIT。",
      "author": "Simon Tatham 及贡献者",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/doc/licence.html",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright 2004-2024 Simon Tatham and contributors"
      },
      "source": {
        "repo": "sgtatham/puzzles",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/",
        "version": "20260923.616da16",
        "date": "2026-09-23"
      },
      "version": "20260923",
      "entry": "index.html",
      "treeHash": "5ff70d73ed0121806a9a6f5c967f42182350e11085eb0d80e31937cc92196b3b",
      "sizeBytes": 313362,
      "fileCount": 6,
      "modifications": [
        "官方 Emscripten/WebAssembly 构建原样托管（index.html 由 flood.html 改名）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "cube-composer",
      "name": "方块作曲家",
      "nameEn": "Cube Composer",
      "category": "puzzle",
      "tags": [
        "编程思维",
        "关卡",
        "键盘"
      ],
      "desc": "用函数组合的方式编写指令，让方块按程序移动、染色、变形。受函数式编程启发的解谜游戏，MIT。",
      "author": "David Peter（sharkdp）",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/sharkdp/cube-composer/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2015-2016 David Peter"
      },
      "source": {
        "repo": "sharkdp/cube-composer",
        "url": "https://github.com/sharkdp/cube-composer",
        "version": "83e5b66 (2026-10-11)",
        "date": "2026-10-11"
      },
      "version": "20261011",
      "entry": "index.html",
      "treeHash": "fcce575cfff6696ad51907ce1995a14a4e4d1d3c81b1d904096de27cc73eeccd",
      "sizeBytes": 934361,
      "fileCount": 50,
      "modifications": [
        "移除 Google Fonts（Roboto Condensed）外链，改用系统字体栈",
        "移除 GitHub Star 按钮 iframe（外部请求）",
        "内置构建产物 dist/main.js（仓库 .gitignore 了 dist/，取自作者官网）",
        "内置构建产物 dist/main.css（仓库 .gitignore 了 dist/，取自作者官网）",
        "保留上游 LICENSE 原文（LICENSE）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "hexgl",
      "name": "极速 HexGL",
      "nameEn": "HexGL",
      "category": "racing",
      "tags": [
        "WebGL",
        "3D",
        "竞速"
      ],
      "desc": "未来反重力飞行器竞速，WebGL 3D 画面，速度感强。原作 Thibaut Despoulain（BKcore），MIT。",
      "author": "Thibaut Despoulain（BKcore）",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/BKcore/HexGL/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2015 Thibaut Despoulain"
      },
      "source": {
        "repo": "BKcore/HexGL",
        "url": "https://github.com/BKcore/HexGL",
        "version": "6addc95 (2021-03-21)",
        "date": "2021-03-21"
      },
      "version": "20210321",
      "entry": "index.html",
      "treeHash": "297db35eb2d7eacd8981d89fc7fb8fc23627d6b8e590ed1e73b8f116f51df4a4",
      "sizeBytes": 20437646,
      "fileCount": 199,
      "modifications": [
        "favicon 指向本地 favicon.png（去掉 hexgl.bkcore.com 外链）",
        "Google Analytics 脚本 → 本地空桩",
        "保留上游 LICENSE 原文（LICENSE）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "hextris",
      "name": "六边形消除",
      "nameEn": "Hextris",
      "category": "arcade",
      "tags": [
        "消除",
        "反应",
        "触屏"
      ],
      "desc": "六边形转盘版方块消除：旋转中心六边形接住落下的色块，三块同色自动消除。GPL-3.0 开源。",
      "author": "Hextris 贡献者团队",
      "license": {
        "spdx": "GPL-3.0",
        "name": "GNU GPL v3.0",
        "url": "https://github.com/Hextris/hextris/blob/master/LICENSE.md",
        "commercial": true,
        "shareAlike": true,
        "notice": "Copyright (c) Hextris contributors · GPL-3.0"
      },
      "source": {
        "repo": "Hextris/hextris",
        "url": "https://github.com/Hextris/hextris",
        "version": "3f4847d (2022-02-08)",
        "date": "2022-02-08"
      },
      "version": "20220208",
      "entry": "index.html",
      "treeHash": "77c2b7c74b04ba5d6a12acf847ce4a49b363451d1555a30db4e99e7bf9106ea3",
      "sizeBytes": 1560955,
      "fileCount": 75,
      "modifications": [
        "移除 Google AdSense 广告脚本",
        "移除 Google Fonts（Exo 2）外链，改用系统字体栈",
        "JS 动态注入的 hextris.io 统计脚本 → 本地空桩",
        "保留上游 LICENSE 原文（LICENSE.md）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "racer",
      "name": "极速赛道",
      "nameEn": "Javascript Racer",
      "category": "racing",
      "tags": [
        "伪3D",
        "键盘",
        "街机"
      ],
      "desc": "OutRun 风格的伪 3D 赛车：弯道、坡道、路肩与来车。Jake Gordon 的经典开源实现，MIT。",
      "author": "Jake Gordon",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/jakesgordon/javascript-racer/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2012-2016 Jake Gordon and contributors"
      },
      "source": {
        "repo": "jakesgordon/javascript-racer",
        "url": "https://github.com/jakesgordon/javascript-racer",
        "version": "3e8a060 (2025-06-01)",
        "date": "2025-06-01"
      },
      "version": "20250601",
      "entry": "v4.final.html",
      "treeHash": "9691bbad1f74dbc2fd363837dbcbca5f2dacd9c26e842d8c86b93d27521c2760",
      "sizeBytes": 8928981,
      "fileCount": 58,
      "modifications": [
        "保留上游 LICENSE 原文（LICENSE）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "orbium",
      "name": "轨道小球",
      "nameEn": "Orbium",
      "category": "puzzle",
      "tags": [
        "物理解谜",
        "关卡",
        "60 关"
      ],
      "desc": "《Log!cal》的现代重制：转动轨道让小球按正确顺序落入洞中，共 60 关。GPL-2.0 开源。",
      "author": "bni（Orbium 团队）",
      "license": {
        "spdx": "GPL-2.0",
        "name": "GNU GPL v2.0",
        "url": "https://github.com/bni/orbium/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": true,
        "notice": "Copyright (c) Orbium contributors · GPL-2.0"
      },
      "source": {
        "repo": "bni/orbium",
        "url": "https://github.com/bni/orbium",
        "version": "d49c4a4 (2024-08-21)",
        "date": "2024-08-21"
      },
      "version": "20240821",
      "entry": "index.html",
      "treeHash": "4e8196adf7f7665a2e3bcef52f91dc82da1e74836d9ffe43990095015eaa7ca1",
      "sizeBytes": 4119528,
      "fileCount": 261,
      "modifications": [
        "保留上游 LICENSE 原文（LICENSE）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "particle-clicker",
      "name": "粒子点击",
      "nameEn": "Particle Clicker",
      "category": "idle",
      "tags": [
        "放置",
        "科普",
        "CERN"
      ],
      "desc": "CERN Webfest 2014 作品：点击粒子、升级探测器、解锁物理学史节点。MIT 开源。",
      "author": "Igor Babuschkin、Kevin Dungs、Tadej Novak、Gabor Biro",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/particle-clicker/particle-clicker/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2014-2016 Igor Babuschkin, Kevin Dungs, Tadej Novak, Gabor Biro"
      },
      "source": {
        "repo": "particle-clicker/particle-clicker",
        "url": "https://github.com/particle-clicker/particle-clicker",
        "version": "d6762d5 (2023-03-14)",
        "date": "2023-03-14"
      },
      "version": "20230314",
      "entry": "index.html",
      "treeHash": "6a3cbf40b46a5e5c5a7f37145f7fa59e355886967c267d51005d6f254fa98f78",
      "sizeBytes": 1337563,
      "fileCount": 101,
      "modifications": [
        "Font Awesome CSS → 本地 vendor/font-awesome/（MIT + SIL OFL 1.1）",
        "jQuery 2.1.1 → 本地 vendor/jquery.min.js（MIT）",
        "AngularJS 1.3 → 本地 vendor/angular.min.js（MIT）",
        "Bootstrap 3.3.1 JS → 本地 vendor/bootstrap.min.js（MIT）",
        "Google Analytics 外链 → 本地空桩",
        "保留上游 LICENSE 原文（LICENSE）",
        "内置第三方库 vendor/jquery.min.js",
        "内置第三方库 vendor/angular.min.js",
        "内置第三方库 vendor/bootstrap.min.js",
        "内置第三方库 vendor/font-awesome/css/font-awesome.min.css",
        "内置第三方库 vendor/font-awesome/fonts/fontawesome-webfont.woff"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "stp-tents",
      "name": "帐篷营地",
      "nameEn": "Tents",
      "category": "logic",
      "tags": [
        "逻辑",
        "配对",
        "网格"
      ],
      "desc": "给每行每列标出帐篷数量，把帐篷与树木一一配对且互不接触。Simon Tatham 谜题集（2026 版），MIT。",
      "author": "Simon Tatham 及贡献者",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/doc/licence.html",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright 2004-2024 Simon Tatham and contributors"
      },
      "source": {
        "repo": "sgtatham/puzzles",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/",
        "version": "20260923.616da16",
        "date": "2026-09-23"
      },
      "version": "20260923",
      "entry": "index.html",
      "treeHash": "d8a258f281be426b004133219b70293468b99d6d3e9ad120c116a097896e2601",
      "sizeBytes": 370795,
      "fileCount": 6,
      "modifications": [
        "官方 Emscripten/WebAssembly 构建原样托管（index.html 由 tents.html 改名）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "swap",
      "name": "换位解谜",
      "nameEn": "Swap",
      "category": "puzzle",
      "tags": [
        "关卡",
        "角色切换",
        "获奖作品"
      ],
      "desc": "2013 GitHub Game Jam 获奖作品：切换不同角色穿越关卡，用各自的特性破解机关。CC-BY-SA 4.0。",
      "author": "Nicholas Moroze",
      "license": {
        "spdx": "CC-BY-SA-4.0",
        "name": "Creative Commons Attribution-ShareAlike 4.0",
        "url": "https://github.com/nmoroze/swap/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": true,
        "notice": "Copyright (c) Nicholas Moroze · CC-BY-SA-4.0"
      },
      "source": {
        "repo": "nmoroze/swap",
        "url": "https://github.com/nmoroze/swap",
        "version": "a3cfb7d (2018-02-16)",
        "date": "2018-02-16"
      },
      "version": "20180216",
      "entry": "index.html",
      "treeHash": "11f7c2d1c3135101ef1f0881b8c8203fb138530752bbb1e0ec2434ddbfa55656",
      "sizeBytes": 2455619,
      "fileCount": 18,
      "modifications": [
        "AddThis 外链移除后补一个空 stub，避免页面 JS 报 addthis is not defined",
        "移除 Google Fonts 外链（改用系统字体栈）",
        "Font Awesome 4.0.3 → 本地 vendor/font-awesome/（MIT + SIL OFL 1.1）",
        "移除 AddThis 社交统计脚本",
        "移除 GitHub 丝带远程图片",
        "保留上游 LICENSE 原文（LICENSE）",
        "内置第三方库 vendor/font-awesome/css/font-awesome.min.css",
        "内置第三方库 vendor/font-awesome/fonts/fontawesome-webfont.woff"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "sudoku",
      "name": "数独",
      "nameEn": "Sudoku JS",
      "category": "puzzle",
      "tags": [
        "数独",
        "移动端",
        "键盘"
      ],
      "desc": "为手机浏览器设计的数独：三档难度、计时、行/列/宫冲突高亮。Thomas Baruchel，MIT。",
      "author": "Thomas Baruchel",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://github.com/baruchel/sudoku-js/blob/master/LICENSE",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright (c) 2017 Thomas Baruchel"
      },
      "source": {
        "repo": "baruchel/sudoku-js",
        "url": "https://github.com/baruchel/sudoku-js",
        "version": "e9df285 (2017-02-22)",
        "date": "2017-02-22"
      },
      "version": "20170222",
      "entry": "index.html",
      "treeHash": "e8b4c47b2a0e62e715a26392a5feb1d6f9c0d2401b1e876304db34772345ae11",
      "sizeBytes": 1401789,
      "fileCount": 217,
      "modifications": [
        "入口文件 sudoku.html 复制为 index.html（静态目录默认 index.html）",
        "保留上游 LICENSE 原文（LICENSE）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "stp-untangle",
      "name": "解缠",
      "nameEn": "Untangle",
      "category": "logic",
      "tags": [
        "连线",
        "无交叉",
        "触屏"
      ],
      "desc": "拖动节点，把所有连线拉开到互不交叉。Simon Tatham 便携谜题集（2026 版），MIT。",
      "author": "Simon Tatham 及贡献者",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/doc/licence.html",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright 2004-2024 Simon Tatham and contributors"
      },
      "source": {
        "repo": "sgtatham/puzzles",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/",
        "version": "20260923.616da16",
        "date": "2026-09-23"
      },
      "version": "20260923",
      "entry": "index.html",
      "treeHash": "a0448c38eed8f840e0c70e9da2401ff2676d9d3489312aea4df9200bd98f924c",
      "sizeBytes": 355149,
      "fileCount": 6,
      "modifications": [
        "官方 Emscripten/WebAssembly 构建原样托管（index.html 由 untangle.html 改名）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "stp-net",
      "name": "连网",
      "nameEn": "Net",
      "category": "logic",
      "tags": [
        "管道",
        "旋转",
        "连通"
      ],
      "desc": "旋转管道拼块，让所有端点连成一张没有断口、没有环的网。Simon Tatham 谜题集，MIT。",
      "author": "Simon Tatham 及贡献者",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/doc/licence.html",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright 2004-2024 Simon Tatham and contributors"
      },
      "source": {
        "repo": "sgtatham/puzzles",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/",
        "version": "20260923.616da16",
        "date": "2026-09-23"
      },
      "version": "20260923",
      "entry": "index.html",
      "treeHash": "169f430800cc9b9fabd310763bab8115d1f0cfd1b19ad462ba067e0cc986a2ef",
      "sizeBytes": 424286,
      "fileCount": 6,
      "modifications": [
        "官方 Emscripten/WebAssembly 构建原样托管（index.html 由 net.html 改名）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "stp-signpost",
      "name": "路标",
      "nameEn": "Signpost",
      "category": "logic",
      "tags": [
        "路径",
        "箭头",
        "网格"
      ],
      "desc": "网格里每个箭头指向序列中的下一个格子，从 1 开始还原整条路径。Simon Tatham 谜题集，MIT。",
      "author": "Simon Tatham 及贡献者",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/doc/licence.html",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright 2004-2024 Simon Tatham and contributors"
      },
      "source": {
        "repo": "sgtatham/puzzles",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/",
        "version": "20260923.616da16",
        "date": "2026-09-23"
      },
      "version": "20260923",
      "entry": "index.html",
      "treeHash": "aac144350792f31f58f9a3b9db56b38eb0823d62b6d77edbe989b0164eba83bb",
      "sizeBytes": 367102,
      "fileCount": 6,
      "modifications": [
        "官方 Emscripten/WebAssembly 构建原样托管（index.html 由 signpost.html 改名）"
      ],
      "externalRefCheck": "PASS"
    },
    {
      "id": "stp-galaxies",
      "name": "星系划分",
      "nameEn": "Galaxies",
      "category": "logic",
      "tags": [
        "分区",
        "对称",
        "网格"
      ],
      "desc": "把网格划分成中心对称的星系，每个星系恰好围住一个中心点。Simon Tatham 谜题集，MIT。",
      "author": "Simon Tatham 及贡献者",
      "license": {
        "spdx": "MIT",
        "name": "MIT License",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/doc/licence.html",
        "commercial": true,
        "shareAlike": false,
        "notice": "Copyright 2004-2024 Simon Tatham and contributors"
      },
      "source": {
        "repo": "sgtatham/puzzles",
        "url": "https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/",
        "version": "20260923.616da16",
        "date": "2026-09-23"
      },
      "version": "20260923",
      "entry": "index.html",
      "treeHash": "4a8bcb09f0a5cd1d42fae978f93c084003e8e7aafdeaf14602ed23d7ba12f846",
      "sizeBytes": 393879,
      "fileCount": 6,
      "modifications": [
        "官方 Emscripten/WebAssembly 构建原样托管（index.html 由 galaxies.html 改名）"
      ],
      "externalRefCheck": "PASS"
    }
  ]
};
