// レンダリングのスモークテスト：Supabaseへの実通信をモックに差し替えた上で、
// 実際に画面を1回描画させ、途中で例外（ReferenceError等）が起きないかを確認する。
//
// これは「memo文字列のマーカー方式から正式カラムに移行した際、1箇所だけ
// 古い変数名（saleInfo）の参照が消し忘れになっていた」ような不具合を、
// デプロイ前に機械的に検出することを目的にしています。
// このテストは jsdom を使うため、実行前に `npm install` が必要です。
//
// ⚠️ 開発時の注記：このテストはClaudeの実行環境（ネットワーク制限あり）では
//    jsdomをインストールできず、実際に動かして確認することができませんでした。
//    ロジック自体は標準的なjsdomの使い方に沿って書いていますが、
//    初回実行時に細部の調整が必要になる可能性があります。
//    ローカルでの実行: npm install && node tests/smoke.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');

function extractInlineScripts(html){
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while((m = re.exec(html)) !== null) scripts.push(m[1]);
  return scripts.join('\n');
}

function stripAllScripts(html){
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
}

// 動作確認用のダミーデータ：交通(往路/復路)・チケット(発売日リマインダー)・
// 宿泊・飲食・その他の6カテゴリを、予約済み/未予約/不要/発売日設定ありなど
// なるべく多くの状態を混ぜて用意し、catPanelContent の各分岐を通過させる
const FAKE_TRIP = {
  id: 'trip-1',
  sport: 'バスケットボール',
  team: 'テストーズ',
  opponent: 'ライバルズ',
  match_date: '2099-01-01',
  start_time: '18:00',
  venue: 'テストアリーナ',
  estimated_cost: 10000,
  booking_details: [
    { category:'transport_outbound', is_booked:true, method:'新幹線', booked_at:'2026-01-01', cost:5000, memo:'窓側席', is_not_needed:false, sale_date:null, sale_time:null, notify_on_sale:false },
    { category:'transport_return', is_booked:false, method:null, booked_at:null, cost:null, memo:null, is_not_needed:true, sale_date:null, sale_time:null, notify_on_sale:false },
    { category:'ticket', is_booked:false, method:null, booked_at:null, cost:null, memo:null, is_not_needed:false, sale_date:'2026-02-01', sale_time:'10:00', notify_on_sale:true },
    { category:'hotel', is_booked:false, method:null, booked_at:null, cost:null, memo:null, is_not_needed:false, sale_date:null, sale_time:null, notify_on_sale:false },
    { category:'food', is_booked:true, method:null, booked_at:null, cost:null, memo:'焼肉に行く', is_not_needed:false },
    { category:'other', is_booked:false, method:null, booked_at:null, cost:null, memo:null, is_not_needed:false },
  ]
};

async function main(){
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const appScript = extractInlineScripts(html);
  const htmlNoScripts = stripAllScripts(html);

  const dom = new JSDOM(htmlNoScripts, {
    url: 'https://example.com/#book=TESTTOKEN',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  // --- ブラウザAPIの最小限のスタブ ---
  window.Notification = class {
    static permission = 'denied';
    static requestPermission(){ return Promise.resolve('denied'); }
  };
  if(!window.navigator.clipboard){
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.resolve() } });
  }
  if(!window.crypto || !window.crypto.randomUUID){
    window.crypto = window.crypto || {};
    window.crypto.randomUUID = () => 'test-' + Math.random().toString(36).slice(2);
  }
  window.matchMedia = window.matchMedia || (() => ({ matches: false }));

  // Supabase SDKは実通信せず、あらかじめ用意したダミーデータを返すだけのモックに差し替える
  window.supabase = {
    createClient(){
      return {
        rpc(fnName){
          if(fnName === 'get_notebook'){
            return Promise.resolve({
              data: {
                notebook: { id:'nb-1', title:'テスト手帳', budget_cap:100000, is_editable:true, share_token:'view-token' },
                trips: [FAKE_TRIP]
              },
              error: null
            });
          }
          if(fnName === 'get_active_ads'){
            return Promise.resolve({ data: [], error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
      };
    }
  };

  // 実行中に起きたエラーを収集する
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  const originalConsoleError = window.console.error.bind(window.console);
  window.console.error = (...args) => { errors.push(args.map(String).join(' ')); };

  // アプリ本体のスクリプトを実行（末尾のinitApp()が自動的に走る）
  try{
    window.eval(appScript);
  }catch(e){
    console.error('✗ スクリプト実行中に同期的な例外が発生しました:', e);
    process.exit(1);
  }

  // initApp()は非同期（Supabase呼び出しを待つ）なので、レンダリングが終わるまで少し待つ
  await new Promise(resolve => setTimeout(resolve, 800));

  const cards = window.document.querySelectorAll('.ticket');
  const failures = [];

  if(errors.length > 0){
    failures.push(`実行中に${errors.length}件のエラーが発生しました:\n  - ${errors.join('\n  - ')}`);
  }
  if(cards.length !== 1){
    failures.push(`遠征カードが1件描画されるはずが、${cards.length}件でした`);
  }

  if(failures.length > 0){
    console.error('✗ レンダリングのスモークテストに失敗しました:\n');
    failures.forEach(f => console.error(' - ' + f));
    process.exit(1);
  }

  console.log('✓ レンダリングのスモークテスト: OK（ダミーデータで1件の遠征カードが例外なく描画されました）');
}

main().catch(e => {
  console.error('✗ テスト実行中に予期しないエラー:', e);
  process.exit(1);
});
