// 構文チェックテスト：index.html内の<script>ブロックがJSとして正しくパースできるか確認する。
// これまでに実際に起きた「関数の書き換え中にリファクタリング漏れで壊れる」事故を、
// デプロイ前・push前に機械的に検出することが目的です。
// ローカルでの実行: node tests/syntax.test.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');

function extractInlineScripts(html){
  // src="..." を持つ外部スクリプト（Supabase SDKのCDN読み込みなど）は対象外にし、
  // アプリ本体のロジックが書かれているインラインスクリプトだけを取り出す
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while((m = re.exec(html)) !== null){
    scripts.push(m[1]);
  }
  return scripts;
}

function main(){
  if(!fs.existsSync(INDEX_HTML)){
    console.error(`✗ index.html が見つかりません: ${INDEX_HTML}`);
    process.exit(1);
  }
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const scripts = extractInlineScripts(html);

  if(scripts.length === 0){
    console.error('✗ インラインの<script>ブロックが1つも見つかりませんでした（HTML構造が変わった可能性があります）');
    process.exit(1);
  }

  const combined = scripts.join('\n');
  const tmpFile = path.join(require('os').tmpdir(), `ensei-techo-syntax-check-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, combined, 'utf-8');

  try{
    execSync(`node --check "${tmpFile}"`, { stdio: 'pipe' });
    console.log('✓ 構文チェック: OK（index.html内のJavaScriptは正しくパースできます）');
  }catch(e){
    console.error('✗ 構文エラーが見つかりました:');
    console.error(e.stderr ? e.stderr.toString() : e.message);
    process.exit(1);
  }finally{
    fs.unlinkSync(tmpFile);
  }
}

main();
