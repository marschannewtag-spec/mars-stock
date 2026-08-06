# SignalDesk — 年度健檢清單

> **一年跑一次就好。** 平常有 CI 守著(`ci.yml` + `deploy-check.yml`),
> 這份清單專門處理**自動化看不到的東西**。
>
> 用法:開 Claude Code,把下面五項的指令逐項貼過去。
> 它**只報告,不修** —— 修什麼、改不改參數,都是你的決定。
>
> 最後產出 `docs/health-YYYY.md`。明年拿去跟今年比,才看得出漂移。

---

## 為什麼需要人工健檢

CI 能擋「程式壞掉」,擋不了這三件事:

1. **外部資料源變了** —— FMP 就對你停用過 legacy 端點。CI 不會每天打你的 API。
2. **策略失效** —— 市場變了、動能不再有效。這種事沒有任何自動化能告訴你,
   只有回測複驗和你的交易紀錄會。
3. **瀏覽器本地狀態** —— IndexedDB 的長歷史涵蓋率不在 repo 裡,CI 看不見。

---

## 第 1 項:資料源健康

```
檢查三個資料源的端點是否仍正常。實際打一次每個 Worker 端點,
驗證回傳格式沒變(不是只看 HTTP 200):
  /timeseries?symbols=SPY,AAPL&outputsize=3   -> 每檔要有 values[] 且含 open/high/low/close
  /history?symbol=SPY&years=16                 -> bars[] 要有 d/o/h/l/c,且最早一筆接近 16 年前
  /movers?type=gainers                         -> movers[] 要有 symbol/name/price/changePct
  /marketcap?symbols=AAPL                      -> marketCaps 要有數值
回報:每個端點的狀態、回傳筆數、最新一筆日期、以及任何欄位名稱的變化。
不要修任何東西。
```

**為什麼**:資料源默默改格式時,App 不會爆炸,只會算出錯的數字。

---

## 第 2 項:邏輯不變量複驗

```
跑 node scripts/verify.mjs,貼出完整輸出。
另外確認並回報:
  - js/strategy.js 的 generateSells 出場條件仍只有 ATR 停損 + 移動停利 + 階梯停利
  - js/presets.js 的 composite 參數與去年的 health 報告是否一致(逐項列出)
  - js/config.js 的 9 個 key 目前的值
不要修任何東西。
```

---

## 第 3 項:重跑六姿態 A/B(最重要的一項)

```
用目前的程式碼和最新的 16 年資料,在瀏覽器的「回測」分頁重跑
六姿態 Monte Carlo A/B。把結果表格完整記錄下來,並與去年的
health 報告比對:
  - 六個姿態的 Calmar 中位數排名有沒有改變?
  - composite 的 A vs B 差異還是同一個方向嗎?
  - 「板塊退燒有害」這個結論還成立嗎?
如果排名或 Calmar 有顯著變化,明確指出來 —— 但不要動任何參數。
```

> ⚠️ 這一項必須在**瀏覽器**跑(需要 IndexedDB 裡的長歷史),CI 做不到。
> 這也是唯一能回答「你的策略還有效嗎」的檢查。**不要跳過。**

---

## 第 4 項:長歷史資料涵蓋率

> 從 v27 起,「回測」分頁**自己就會顯示**涵蓋率(`33/101 檔`)、低於 90% 時跳警告,
> 回測結果也會標明「參與股票 N/100 檔」。所以第一步先看畫面就好。
> 缺檔時按 **「只補抓缺少的 N 檔」**(會跳過已載入的,不會整批重抓)。
>
> 下面的 Console 腳本是備援,用來看**逐檔**的細節(哪些檔涵蓋不足 16 年)。

```
在瀏覽器 Console 執行,統計 IndexedDB 裡的長歷史涵蓋率:

  const req = indexedDB.open('signaldesk_hist');
  req.onsuccess = async () => {
    const db = req.result;
    const tx = db.transaction('bars', 'readonly').objectStore('bars');
    const keys = await new Promise(r => { const q = tx.getAllKeys(); q.onsuccess = () => r(q.result); });
    const rows = [];
    for (const k of keys.filter(k => k !== '__meta__')) {
      const b = await new Promise(r => {
        const q = db.transaction('bars','readonly').objectStore('bars').get(k);
        q.onsuccess = () => r(q.result);
      });
      rows.push({ symbol: k, bars: b?.length ?? 0, from: b?.[0]?.d, to: b?.[b.length-1]?.d });
    }
    console.table(rows.sort((a,b) => a.bars - b.bars));
    console.log('有資料:', rows.length, '/ 101');
    console.log('涵蓋 16 年(>3800 根):', rows.filter(r => r.bars > 3800).length);
  };

回報:實際數字 —— 幾檔有資料、幾檔涵蓋完整 16 年、哪些缺失。
```

> **這個數字會直接影響回測的可信度。** 如果 101 檔裡只有一半有長歷史,
> 那六姿態 A/B 的 Calmar 是跑在半個股票池上算出來的 —— 結論的適用範圍
> 比你以為的窄。每年記錄這個數字,寫進 health 報告。

---

## 第 5 項:安全與部署

```
1. 確認沒有 API key 洩漏:跑 verify.mjs 的金鑰檢查,
   並到 GitHub repo → Settings → Security → Secret scanning 看有無警報。
2. 確認 Cloudflare Worker 的三個 secret 都還在:TD_API_KEY / TIINGO_KEY / FMP_API_KEY。
3. 跑 node scripts/check-deploy.mjs,確認線上版本與 repo 一致。
4. 確認 Worker 的 ALLOWED_ORIGIN 設定(沒設 = 任何網站都能用你的額度)。
回報狀態,不要修。
```

---

## 產出

```
把以上五項的結果整理成 docs/health-YYYY.md,格式:
  - 每項的實際數字與狀態
  - 與去年的差異(如果有去年的報告)
  - 你發現但沒動的問題清單,按嚴重度排序
不要修任何東西 —— 修什麼由我決定。
```

---

## 最後的誠實提醒

**這整套自動化不會讓你賺錢。** 它讓系統不腐爛、部署不出包 —— 這是真價值,
但跟績效無關。績效取決於你的交易紀錄,不取決於 CI 是不是綠的。

**「完全零人為介入」不存在。** CI 擋得掉壞版本,擋不掉「邏輯正確但策略失效」。
所以第 3 項不是可選項。

**護欄要靠你維持。** `CLAUDE.md` 寫得再好,你哪天說「幫我加個基本面篩選吧」,
它還是會照做。真正的護欄是你自己的紀律。
