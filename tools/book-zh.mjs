/* ============================================================
 * 开局族名中文译名表 —— 与 src/book.js 的 NFAM **按下标一一对齐**
 * (gen-book.mjs 装载时断言长度一致;改 book.js 谱库重生成后若族数变了,
 * 这里要同步补/删)。
 *
 * 译名口径(大陆国象文献/中文维基的通行译法):
 *   · 有定译的用定译:Sicilian=西西里防御、Caro-Kann=卡罗-卡恩防御、
 *     King's Gambit=王翼弃兵、Ruy Lopez=西班牙开局、King's Indian Defense=
 *     古印度防御(注意与 King's Indian Attack=王翼印度进攻 是两条不同定译)、
 *     Petrov=俄罗斯防御、Benko=本科弃兵(沃尔加弃兵的同名开局)等;
 *   · 人名音译(安德森/伯德/雷蒂/阿廖欣/塔拉什…),复合人名保留连字符;
 *   · 无通行中文译名的冷门/玩笑开局按人名音译,形象名直译
 *     (Hippopotamus=河马、Kangaroo=袋鼠、Pterodactyl=翼龙;Sodium Attack
 *     的 Na 双关在中文里恰好成立,译「钠进攻」);
 *   · 后缀:Defense 防御 · Attack 进攻 · Opening 开局 · Game 开局 ·
 *     System 体系 · Formation 布局 · Gambit 弃兵 · Countergambit 反弃兵 ·
 *     Accepted 接受 · Declined 拒绝 · Line 变例;
 *   · 变着(", with X")用括号记法:伦敦体系(Bd3)。
 * ============================================================ */
export const BOOK_ZH = [
  '阿马尔开局',            // 0 Amar Opening
  '阿姆斯特丹进攻',        // 1 Amsterdam Attack
  '安德森开局',            // 2 Anderssen's Opening
  '巴恩斯开局',            // 3 Barnes Opening
  '克莱门斯开局',          // 4 Clemenz Opening
  '匍匐布局',              // 5 Creepy Crawly Formation
  '通用布局',              // 6 Formation
  '环球开局',              // 7 Global Opening
  '格罗布开局',            // 8 Grob Opening
  '匈牙利开局',            // 9 Hungarian Opening
  '卡达什开局',            // 10 Kádas Opening
  '拉斯克车轮战特例',      // 11 Lasker Simul Special
  '米泽斯开局',            // 12 Mieses Opening
  '波兰开局',              // 13 Polish Opening
  '波兰开局(d5)',          // 14 Polish Opening, with d5
  '萨拉戈萨开局',          // 15 Saragossa Opening
  '钠进攻',                // 16 Sodium Attack(Na3 的双关)
  '巴伦西亚开局',          // 17 Valencia Opening
  '范希特开局',            // 18 Van Geet Opening
  '范特克鲁伊斯开局',      // 19 Van't Kruijs Opening
  '韦尔开局',              // 20 Ware Opening
  '尼姆佐-拉尔森进攻',     // 21 Nimzo-Larsen Attack
  '伯德开局',              // 22 Bird Opening
  '科勒体系',              // 23 Colle System
  '现代防御',              // 24 Modern Defense
  '祖科托特防御',          // 25 Zukertort Defense
  '祖科托特开局',          // 26 Zukertort Opening
  '王翼印度进攻',          // 27 King's Indian Attack
  '王翼印度进攻(Bf5)',     // 28 King's Indian Attack, with Bf5
  '王翼印度进攻(e6)',      // 29 King's Indian Attack, with e6
  '雷蒂开局',              // 30 Réti Opening
  '英格兰开局',            // 31 English Opening
  '英格兰猩猩弃兵',        // 32 English Orangutan
  '澳大利亚防御',          // 33 Australian Defense
  '别诺尼防御',            // 34 Benoni Defense
  '博尔格防御',            // 35 Borg Defense
  '英格兰防御',            // 36 English Defense
  '恩格伦弃兵',            // 37 Englund Gambit
  '恩格伦弃兵拒绝',        // 38 Englund Gambit Declined
  '霍罗威茨防御',          // 39 Horwitz Defense
  '袋鼠防御',              // 40 Kangaroo Defense
  '米克纳斯防御',          // 41 Mikenas Defense
  '蒙得维的亚防御',        // 42 Montevideo Defense
  '波兰防御',              // 43 Polish Defense
  '翼龙防御',              // 44 Pterodactyl Defense
  '后兵开局',              // 45 Queen's Pawn Game
  '斯拉夫印度防御',        // 46 Slav Indian
  '扎伊尔防御',            // 47 Zaire Defense
  '旧印度防御',            // 48 Old Indian Defense
  '老鼠防御',              // 49 Rat Defense
  '罗巴奇防御',            // 50 Robatsch Defense
  '韦德防御',              // 51 Wade Defense
  '印度防御',              // 52 Indian Defense
  '亚马逊进攻',            // 53 Amazon Attack
  '巴斯克开局',            // 54 Basque Opening
  '卡纳尔开局',            // 55 Canard Opening
  '佩尔费斯进攻',          // 56 Paleface Attack
  '特龙波夫斯基进攻',      // 57 Trompowsky Attack
  '德里防御',              // 58 Döry Defense
  '托雷进攻',              // 59 Torre Attack
  '尤苏波夫-鲁宾斯坦体系', // 60 Yusupov-Rubinstein System
  '玛丽恩巴德体系',        // 61 Marienbad System
  '伪后翼印度防御',        // 62 Pseudo Queen's Indian Defense
  '东印度防御',            // 63 East Indian Defense
  '伦敦体系',              // 64 London System
  '伦敦体系(Bd3)',         // 65 London System, with Bd3
  '伦敦体系(Be2)',         // 66 London System, with Be2
  '墨西哥防御',            // 67 Mexican Defense
  '加速后翼印度防御',      // 68 Queen's Indian Accelerated
  '格林菲尔德防御',        // 69 Grünfeld Defense
  '秃鹫防御',              // 70 Vulture Defense
  '本科弃兵',              // 71 Benko Gambit
  '本科弃兵接受',          // 72 Benko Gambit Accepted
  '本科弃兵拒绝',          // 73 Benko Gambit Declined
  '荷兰防御',              // 74 Dutch Defense
  '巴恩斯防御',            // 75 Barnes Defense
  '卡尔防御',              // 76 Carr Defense
  '杜拉斯弃兵',            // 77 Duras Gambit
  '弗里德狐防御',          // 78 Fried Fox Defense
  '戈德史密斯防御',        // 79 Goldsmith Defense
  '河马防御',              // 80 Hippopotamus Defense
  '王兵开局',              // 81 King's Pawn Game
  '旅鼠防御',              // 82 Lemming Defense
  '狮子防御',              // 83 Lion Defense
  '尼姆佐维奇防御',        // 84 Nimzowitsch Defense
  '欧文防御',              // 85 Owen Defense
  '皮尔茨防御',            // 86 Pirc Defense
  '圣乔治防御',            // 87 St. George Defense
  '韦尔防御',              // 88 Ware Defense
  '斯堪的纳维亚防御',      // 89 Scandinavian Defense
  '阿廖欣防御',            // 90 Alekhine Defense
  '捷克防御',              // 91 Czech Defense
  '卡罗-卡恩防御',         // 92 Caro-Kann Defense
  '西西里防御',            // 93 Sicilian Defense
  '法兰西防御',            // 94 French Defense
  '邦克劳德进攻',          // 95 Bongcloud Attack
  '中心开局',              // 96 Center Game
  '王翼兵开局',            // 97 King's Pawn Opening
  '葡萄牙开局',            // 98 Portuguese Opening
  '中心开局(接受弃兵)',    // 99 Center Game Accepted
  '丹麦弃兵',              // 100 Danish Gambit
  '丹麦弃兵接受',          // 101 Danish Gambit Accepted
  '丹麦弃兵拒绝',          // 102 Danish Gambit Declined
  '象开局',                // 103 Bishop's Opening
  '维也纳弃兵(马克斯·兰格防御)', // 104 Vienna Gambit, with Max Lange Defense
  '维也纳开局',            // 105 Vienna Game
  '王翼弃兵',              // 106 King's Gambit
  '王翼弃兵拒绝',          // 107 King's Gambit Declined
  '王翼弃兵接受',          // 108 King's Gambit Accepted
  '象弃兵',                // 109 Elephant Gambit
  '贡德拉姆防御',          // 110 Gunderam Defense
  '王翼马开局',            // 111 King's Knight Opening
  '拉脱维亚弃兵',          // 112 Latvian Gambit
  '拉脱维亚弃兵接受',      // 113 Latvian Gambit Accepted
  '菲利多尔防御',          // 114 Philidor Defense
  '俄罗斯防御',            // 115 Petrov's Defense
  '德累斯顿开局',          // 116 Dresden Opening
  '爱尔兰弃兵',            // 117 Irish Gambit
  '彭齐亚尼开局',          // 118 Ponziani Opening
  '苏格兰开局',            // 119 Scotch Game
  '三马开局',              // 120 Three Knights Opening
  '四马开局',              // 121 Four Knights Game
  '意大利开局',            // 122 Italian Game
  '西班牙开局',            // 123 Ruy Lopez
  '布莱克马尔-迪梅尔弃兵', // 124 Blackmar-Diemer Gambit
  '布莱克马尔-迪梅尔弃兵接受', // 125 Blackmar-Diemer Gambit Accepted
  '布莱克马尔-迪梅尔弃兵拒绝', // 126 Blackmar-Diemer Gambit Declined
  '拉波尔-乔巴瓦体系',     // 127 Rapport-Jobava System
  '拉波尔-乔巴瓦体系(e6)', // 128 Rapport-Jobava System, with e6
  '里希特-韦列索夫进攻',   // 129 Richter-Veresov Attack
  '后翼弃兵拒绝',          // 130 Queen's Gambit Declined
  '鲁宾斯坦开局',          // 131 Rubinstein Opening
  '后翼弃兵',              // 132 Queen's Gambit
  '斯拉夫防御',            // 133 Slav Defense
  '后翼弃兵接受',          // 134 Queen's Gambit Accepted
  '半斯拉夫防御',          // 135 Semi-Slav Defense
  '塔拉什防御',            // 136 Tarrasch Defense
  '半斯拉夫防御接受',      // 137 Semi-Slav Defense Accepted
  '新格林菲尔德防御',      // 138 Neo-Grünfeld Defense
  '加泰罗尼亚开局',        // 139 Catalan Opening
  '布卢门菲尔德反弃兵',    // 140 Blumenfeld Countergambit
  '布卢门菲尔德反弃兵接受', // 141 Blumenfeld Countergambit Accepted
  '博戈-印度防御',         // 142 Bogo-Indian Defense
  '后翼印度防御',          // 143 Queen's Indian Defense
  '后翼印度防御(e3)',      // 144 Queen's Indian Defense, with e3
  '后翼印度防御(e3,Bb4+ 变例)', // 145 Queen's Indian, with e3, Bb4+ Line
  '尼姆佐-印度防御',       // 146 Nimzo-Indian Defense
  '古印度防御',            // 147 King's Indian Defense
  '后兵开局(门加里尼进攻)', // 148 Queen's Pawn, Mengarini Attack
];
