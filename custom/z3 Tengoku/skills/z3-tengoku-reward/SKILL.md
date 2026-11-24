---
name: z3-tengoku-reward
description: Decrypt STGZ3OF2.SDAT, parse GIFT reward tables, serialize part and unit grants, and repack CPK. Use when the user asks to add or modify stage-clear rewards (Z chip, boost parts, units) for 第3次超级机器人大战Z 天狱篇. Do not use for RPW_DATA part data editing which is handled by readRpwData.js.
---

# Z3 Tengoku — Stage Reward Editor

This skill covers how to read, modify, and write back the stage-clear GIFT reward system in `STGZ3OF2.SDAT` for SRWZ Tengoku-hen. All scripts referenced are in the sibling `../` directory of this file.

---

## 1. Decryption Chain

```
STGZ3OF2.SDAT  (NPD/EDAT v4 encrypted CPK)
        │
        ▼  decryptEdat(raw, parseNpdHeader(raw))   [readSTGZ3OF2.SDAT.js]
   plain CPK (4.7 MB)
        │
        ▼  parseCpk(plain)                          [readSTGZ3OF2.SDAT.js]
   cpk.entries[]   →  {ID, size, extractSize, contentOffset}
        │
        ▼  readCpkEntry(plain, cpk, ID) + CRILAYLA decompress
   876 files: 873 are Lua level scripts
```

### 1.1 NPD / EDAT v4
- Header signature: `NPD`
- Key derivation: `crypt_key = SDAT_KEY XOR devHash`
- Body is AES-128-CBC in fixed-size blocks; each block's IV is re-derived from `digest + blockIndex`
- `parseNpdHeader()` returns `{devHash, digest, size}`; `decryptEdat()` returns full plaintext buffer
- **Writeback is only plain CPK today** — EDAT re-encryption is not implemented. Whether the game accepts plain CPK still needs verification on real hardware.

### 1.2 CPK Container
- Magic: `CPK ` (4 bytes + 4 padding bytes)
- UTF table precedes file entries; entries are variable-length records
- `parseCpk()` returns `{entries: [{ID, size, extractSize, contentOffset}]}`
- `readCpkEntry(plain, cpk, ID)` reads and CRILAYLA-decompresses the entry body; returns a Buffer (Lua script text as Shift-JIS byte sequence)
- Writeback must rebuild the entire CPK: re-read all other entries, re-pack UTF table with new offsets, then overwrite

### 1.3 Per-Entry Size Change on Modification
Lua level scripts are CRILAYLA-compressed. Changing the text length causes decompressed size to change, which shifts every subsequent entry's `contentOffset`. **Always rebuild the full CPK, never patch in-place.**

---

## 2. GIFT Table Format

### 2.1 Discovery
GIFT tables are **Lua globals** defined inside level scripts, not a separate binary table:

```
GIFT_510={  2,-1,-1,0, 1, 51,"", 99, 0,  -1,-1,0, 3,-1,"強化パーツ「...」を入手しました。", 0, 1,  }
         ↑count              ↑kind                    ↑kind                                 ↑tail
```

### 2.2 General Structure
```
GIFT_XXX = {
    N,          ← count = number of 8-field records
    r0_f0, r0_f1, r0_f2, r0_kind, r0_f4, r0_f5, r0_f6, r0_f7,   ← record 0
    r1_f0, r1_f1, r1_f2, r1_kind, r1_f4, r1_f5, r1_f6, r1_f7,   ← record 1
    ...
}
```

- **All 94 tables in the CPK end with a trailing comma before `}`** — preserve this.
- Fields are delimited by commas with no whitespace after commas.
- String fields (`f5`, the message) must be **Shift-JIS encoded**, wrapped in ASCII `"` quotes.

### 2.3 Record kind Reference

| kind | Meaning | f4 | f6 | Notes |
|---|---|---|---|---|
| **0** | 金钱（特殊变体） | — | 金额 | 只在 entry 863 商店表样例出现过 1 次 |
| **1** | 强化零件 | **零件ID (partList.json.value)** | **数量** | 原版所有零件记录 f6=1；99 未实机验证 |
| **2** | 机体 | **??? 编号空间未定位** | 0 | 唯一已知样例 GIFT_501/entry133 写 104 但文本是「サーペント」；robot 表中 サーペント=198、104=地上戦艦；RPW_DATA 内无 104→198 映射；**实机验证前不要假设 f4 就是 partList / robot 表 ID** |
| **3** | 消息文本 | -1 | 0 | f5=Shift-JIS 日文本；f7=固定 1 |
| **4** | Z 芯片（金钱） | -1 | 金额 | 最常见的 kind，关卡奖励默认类型 |

### 2.4 完整字段模板（按 count+8 记录格式序列化）

```js
// GIFT_510 — 强化零件奖励 (kind=1)
partRecord = ['-1', '-1', '0', '1', String(partId), '""', String(quantity), '0']
// count + partRecords... + messageRecord
giftBody = [String(count), ...partRecords.flat(), ...messageRecord, '']
// → ['2', '-1', '-1', '0', '1', '51', '""', '99', '0',
//       '-1', '-1', '0', '3', '-1', '"強化パーツ「xxx」を入手しました。"', '0', '1', '']

// GIFT_501 — 机体奖励 (kind=2)
unitRecord = ['-1', '-1', '0', '2', String(unit_id), '""', '0', '0']
messageRecord = ['-1', '-1', '0', '3', '-1', '"機体「ユニット名」を入手した。"', '0', '1']

// GIFT_500 — 金钱奖励 (kind=4)
moneyRecord = ['-1', '-1', '0', '4', '-1', '""', String(amount), '0']
moneyMessageRecord = ['-1', '-1', '0', '3', '-1', '"Ｚチップ XXX Ｚを入手しました"', '0', '1']
```

### 2.5 Trailing Comma
**Every original GIFT table ends with `,}` after the last field.** Include the empty string element in the array so the last comma is emitted. Example: `...1,""},` then `}`.

---

## 3. SC_GIFT_EXEC Insertion

### 3.1 Pairing Rule
GIFT table `GIFT_XXX` is typically **defined in entry N and invoked in entry N+1** by `SC_GIFT_EXEC_B(GIFT_XXX)` inside `EventFunc_StageClear()`:

| Entry pair | GIFT name | Invocation |
|---|---|---|
| 19 / 20 | GIFT_501 | `SC_GIFT_EXEC_B(GIFT_501)` |
| 91 / 92 | GIFT_501 | `SC_GIFT_EXEC_B(GIFT_501)` |
| 133 / 134 | GIFT_501 | `SC_GIFT_EXEC_B(GIFT_501)` |
| 169 / 170 | GIFT_501 | `SC_GIFT_EXEC_B(GIFT_501)` |
| 192 / 193 | GIFT_510 | `SC_GIFT_EXEC_B(GIFT_510)` (two call sites) |
| 345 / 346 | GIFT_510 | `SC_GIFT_EXEC_B(GIFT_510)` |
| 441 / 442 | GIFT_510 | `SC_GIFT_EXEC_B(GIFT_510)` |
| 608 / 609 | GIFT_510 | `SC_GIFT_EXEC_B(GIFT_510)` |
| 686 / 687 | GIFT_510 | `SC_GIFT_EXEC_B(GIFT_510)` |

### 3.2 StageClear Function Context
`SC_GIFT_EXEC_B(GIFT_XXX)` is inserted **inside `EventFunc_StageClear()`**, typically between:
```
SC_SDEMO_B( 2 );
SC_TERRITORY_MAP_B();           ← or SC_BRANCH_INIT(); SC_BRANCH_PLATE_B();
SC_GIFT_EXEC_B( GIFT_XXX );
SC_PLAYER_ENTRY( TOUROKU_NNN );
SC_PROCESS_SET_NEXT_STAGE( "xxxx" );
```

### 3.3 Prologue Special Case
序章 (entry 2) does **not** currently have `SC_GIFT_EXEC_B` or any GIFT table (entry 1 is TOUROKU / SCRAMBLE table block). 为序章新增奖励需要：
1. 在 entry 1 (TOUROKU 区块结尾前) 追加 `GIFT_501={...}` 或 `GIFT_510={...}` 全局定义
2. 在 entry 2 的 `EventFunc_StageClear()` 里插入 `SC_GIFT_EXEC_B(GIFT_xxx);`

---

## 4. RPW_DATA Robot Table (Unit List Source)

### 4.1 RPW_DATA Layout
RPW_DATA.CPK is a plain CPK (no EDAT), single entry containing a CRILAYLA-compressed `<mt>` container with 24 chunks:

| chunk | size | purpose |
|---|---|---|
| `j-string` | 128550 B | All Shift-JIS text strings, null-terminated |
| `robot` | 100704 B | Unit parameter table: **1049 records × 96 bytes** |
| `pilot` | 62064 B | Pilot table: 1293 records × 48 bytes |
| `weapon` | 146224 B | Weapon table |
| `boost-p` | 6636 B | 强化零件表 (same partList.json source) |
| `ridividx` | 8392 B | robot → j-string-name-offset + robot-ID mapping |

### 4.2 robot Record Structure
```
offset size  desc
+0     u32   机体类型标识 (3=ザンボット３, 1=バンドック, 2=サーペント/地上戦艦...)
+8     u32   机体名在 j-string 里的偏移
+16    u16   最大 EN
+28    u16   最大 HP
+32    u16   移动力
+34    u16   运动性
+36    u16   照准值
+58    u16   机体 ID ← 等于 robot 表的记录序号
```

**1049 条全部满足 `record index == unit ID`，且全部有名字，无空名条目。**

### 4.3 unitList.json 来源
`unitList.json` 里的 `value` 字段就是 RPW_DATA `robot` 表的记录序号。名字字段直接来自 `j-string` 块，是游戏内显示名（无用户追加的 `（味方）（ボス）（弱）` 等后缀）。

### 4.4 同名不同 ID 情况
多台 `サーペント` 记录在 robot 表里是独立条目（ID 198/199/200/202/978 各有不同 HP）。在 UI 下拉里**名字相同，只能靠 ID 或 HP 区分**。

---

## 5. Known Issues and Risks

| Item | Status |
|---|---|
| EDAT 重加密 | **未实现** — 当前仅覆盖写回明文 CPK；游戏能否加载待实机验证 |
| CPK 重打包 | **脚本里已有**（`editSTGZ3OF2.js`）— 重算 UTF 表偏移和 contentOffset |
| kind=2 unit ID 编号空间 | **未定位** — GIFT 里写 104 但文本是 サーペント；robot 表里 サーペント=198；RPW_DATA 内无 104→198 映射；**实机二分验证前不要假设是 robot ID** |
| kind=1 数量上限 | **原版全 1** — 99 未实机验证是否被引擎接受 |
| 序章无现成 GIFT | 需新增表定义 + 插入 EXEC 调用 |
| `ScGf_get_*` flag | 仅剧情状态标记，不是机体入库开关 |

---

## 6. Verification Scripts

These one-off scripts under `/tmp/` were used during this session and can be reused:

| Script | What it does |
|---|---|
| `/tmp/z3_rpw_chunks.js` | Enumerate RPW_DATA `<mt>` chunks with sizes |
| `/tmp/z3_unit_verify.js` | Extract all robot records, validate unitList.json names/HP against game data |
| `/tmp/z3_gift_pair.js` | Scan all CPK entries for GIFT definitions and SC_GIFT_EXEC invocations, output entry pairs |
| `/tmp/z3_unit_scan.js` | Statistic all GIFT record kinds with unique text samples per kind |
| `/tmp/z3_entry133.js` | Dump entry 133 (the only known kind=2 unit-gift GIFT) with TOUROKU tables and StageClear |

All scripts assume `node --max-old-space-size=4096` because CPK decompression peaks near 500 MB.

---

## 7. editSTGZ3OF2.js Save Flow

When a user saves stage rewards, the script in `../editSTGZ3OF2.js` should:

1. Re-decrypt STGZ3OF2.SDAT from user-specified folder (not local copy)
2. Parse CPK
3. Locate **current chapter's pair of entries** (define + exec) or Prologue's entry 1/2
4. If existing GIFT table exists: rewrite in-place preserving trailing comma
5. If not exists: append GIFT_NNN={...} before TOUROKU table ends (entry 1), insert `SC_GIFT_EXEC_B(GIFT_NNN);` into `EventFunc_StageClear()`
6. CRILAYLA re-compress each modified entry
7. Re-pack full CPK: re-write UTF table, re-compute all `contentOffset`
8. **Write plain CPK back into the file location** (EDAT layer skipped)
9. Report to user; warn that EDAT layer and in-game acceptance need verification

Key naming convention: `GIFT_510` = 零件奖励, `GIFT_500` = 金钱奖励, `GIFT_501` = 综合/剧情奖励（机体、分支）。续编号 `GIFT_502`, `GIFT_520` 等也出现过，保持关卡原有编号风格。
