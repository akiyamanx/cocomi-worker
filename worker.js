// worker.js v2.6 — COCOMI Worker
// このファイルはCloudflare Workerのメインハンドラ
// v1.0: LINE Webhook受信→テキスト指示→GitHub push→LINE返信
// v1.1追加: LINEファイル受信→種別自動判定→capsules/missions/にGitHub push
// v1.2修正: sanitizeForFilename強化(「」.md等の除去、30文字制限)
// v1.3追加: dest指定ルーティング(ファイル先頭の<!-- dest: パス -->で配置先を指定可能)
// v1.4追加: フォルダ一覧コマンド&フォルダ中身確認コマンド
// v1.5改善: 全コマンドの表記揺れ対応(スペースなし・全角スペース・別名追加)
// v1.6改善: destタグ最優先ルーティング
// v2.0追加: 安全バリデーション — テキスト指示にプロジェクト名必須化&missionタグ自動注入
// v2.5追加: スマート振り分け — ファイルアップロード時の多段階判定&missionタグ自動注入&M-リネーム
// v2.1追加: リッチメニュー対応 — ヘルプ/読むコマンド追加、ファイル内容LINE表示
// v2.2追加: Flex Message対応 — カプセル/フォルダ一覧をタップ可能なボタン付きカードで返信
// v2.3追加: ファイル名降順ソート&「もっと見る」ページネーション
// v2.4改善: 日付抽出ソート(全ファイル混合で新しい順)&ボタン表示名短縮
// v2.6追加: キーワード振り分け強化 — アイデア/メモ/計画書対応+ideasサブフォルダ自動判定+inboxガイド

// ============================================================
// 定数定義
// ============================================================

// v1.0 テキスト指示用のプロジェクトホワイトリスト
const VALID_PROJECTS = [
  'genba-pro',
  'culo-chan',
  'maintenance-map',
  'cocomi-postman',
  'cocomi-family'
];
const DEFAULT_PROJECT = 'genba-pro';

// v1.1追加 v2.6拡張 ファイル種別→保管先のマッピングルール
// ファイル名に含まれるキーワードで判定(上から順に評価、最初にマッチしたものが適用)
// ★DIFFをMASTERより先に判定(「MASTER追記用_DIFF」のようなケースに備える)
const FILE_ROUTING_RULES = [
  // capsules/daily/ — DIFFカプセル・セッション系
  { keywords: ['DIFF_DEV', '開発カプセル'],   dest: 'capsules/daily' },
  { keywords: ['DIFF_総合', '思い出カプセル_DIFF'], dest: 'capsules/daily' },
  { keywords: ['DIFF'],                       dest: 'capsules/daily' },
  { keywords: ['引き継ぎ', 'セッションまとめ', 'セッション完全まとめ'], dest: 'capsules/daily' },
  // capsules/daily/ — v2.6追加: メモ系もdailyへ(見失い防止)
  { keywords: ['メモ', 'memo', 'ノート', 'note'], dest: 'capsules/daily' },
  // capsules/master/ — MASTER系(CURRENT/ARCHIVEも含む)
  { keywords: ['MASTER'],                     dest: 'capsules/master' },
  // capsules/plans/ — v2.6拡張: 計画書/proposal追加
  { keywords: ['企画書', '計画書', 'proposal'], dest: 'capsules/plans' },
  // ideas/ — v2.6追加: アイデア・TODO系
  { keywords: ['アイデア', 'ideas', 'idea', 'やること', 'TODO', 'todo'], dest: 'ideas' },
  // dev-capsules/ — v2.6追加: 開発メモ・技術検証
  { keywords: ['dev-capsule', '開発メモ', '技術メモ'], dest: 'dev-capsules' },
  // missions/ — 指示書系
  { keywords: ['指示書', 'Step', 'step'],     dest: 'missions/inbox' },
];
const DEFAULT_DEST = 'inbox';

// v1.4追加 フォルダ一覧で探索するトップレベルフォルダ
const TOP_LEVEL_FOLDERS = [
  'missions',
  'capsules',
  'inbox',
  'reports',
  'errors',
  'ideas',
  'templates',
];

// GitHubリポ情報
const GITHUB_OWNER = 'akiyamanx';
const GITHUB_REPO = 'cocomi-postman';

// ============================================================
// 署名検証(v1.0から変更なし)
// ============================================================

// HMAC-SHA256でLINE Webhookの署名を検証する
async function verifySignature(body, signature, channelSecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}

// ============================================================
// テキスト指示パース(v2.0 安全バリデーション強化)
// ============================================================

// v2.0修正: テキストをプロジェクト名と指示内容に分離する
// プロジェクト名が明示されていない場合はnullを返す(安全策)
function parseInstruction(text) {
  const match = text.match(/^([^:：]+)[：:](.+)$/s);
  if (match) {
    const projectCandidate = match[1].trim().toLowerCase();
    if (VALID_PROJECTS.includes(projectCandidate)) {
      return { project: projectCandidate, instruction: match[2].trim(), valid: true };
    }
  }
  // v2.0変更: プロジェクト名なし → 無効扱い(以前はデフォルトに飛ばしていた)
  return { project: null, instruction: text.trim(), valid: false };
}

// ============================================================
// ID・ファイル名生成
// ============================================================

// M-LINE-MMDD-HHmm形式のミッションIDを生成する(JST)
function generateMissionId() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  return `M-LINE-${mm}${dd}-${hh}${min}`;
}

// v1.2修正 - ファイル名サニタイズ強化
function sanitizeForFilename(text) {
  return text
    .replace(/\.[a-zA-Z]{1,5}\b/g, '')
    .replace(/[\/\\?%*:|"<>「」『』()()\[\]{}.,;:!!?##&&@@·。、]/g, '')
    .replace(/\s+/g, '')
    .substring(0, 30);
}

// ============================================================
// 指示書Markdown生成(v2.0 missionタグ自動注入)
// ============================================================

// v2.0修正: 指示書に <!-- mission: project-id --> を自動注入する
function createMissionContent(missionId, project, instruction) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = jst.toISOString().replace('Z', '+09:00');

  return `<!-- mission: ${project} -->
# ${missionId}: ${instruction.substring(0, 50)}
## プロジェクト: ${project}
## 送信元: LINE
## 日時: ${dateStr}

${instruction}
`;
}

// ============================================================
// ファイル種別判定(v1.1 + v1.3 + v2.0強化)
// ============================================================

// v1.1 ファイル名からキーワードマッチで保管先フォルダを判定する
// v2.6改修: ideas/の場合はサブフォルダも自動判定
function classifyFile(fileName) {
  for (const rule of FILE_ROUTING_RULES) {
    for (const keyword of rule.keywords) {
      if (fileName.includes(keyword)) {
        // v2.6追加: ideas/の場合、プロジェクト名でサブフォルダ振り分け
        if (rule.dest === 'ideas') {
          return classifyIdeasSubfolder(fileName);
        }
        return rule.dest;
      }
    }
  }
  return null;
}

// v2.6追加: ideas/のサブフォルダをファイル名から自動判定
function classifyIdeasSubfolder(fileName) {
  const lower = fileName.toLowerCase();
  if (/culo|会計|kaikei|経理/.test(fileName) || /culo/.test(lower)) return 'ideas/culo-chan';
  if (/genba|現場|設備|setsubikun/.test(fileName) || /genba/.test(lower)) return 'ideas/genba-pro';
  if (/postman|ポストマン|cocomi-postman/.test(fileName) || /postman/.test(lower)) return 'ideas/cocomi-postman';
  if (/maintenance|メンテ|map/.test(fileName) || /maintenance/.test(lower)) return 'ideas/maintenance-map';
  return 'ideas/unassigned';
}

// v1.3追加: ファイル中身の先頭から <!-- dest: パス --> を抽出する
function extractDestFromContent(content) {
  const lines = content.split('\n').slice(0, 5);
  for (const line of lines) {
    const match = line.match(/<!--\s*dest:\s*(.+?)\s*-->/);
    if (match) {
      return match[1].trim().replace(/^\/+|\/+$/g, '');
    }
  }
  return null;
}

// v2.0追加: ファイル中身の先頭から <!-- mission: project-id --> を抽出する
function extractMissionTag(content) {
  const lines = content.split('\n').slice(0, 10);
  for (const line of lines) {
    const match = line.match(/<!--\s*mission:\s*(\S+)\s*-->/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

// v2.5追加: ファイル中身の先頭から <!-- project: project-id --> を抽出する
function extractProjectTag(content) {
  const lines = content.split('\n').slice(0, 10);
  for (const line of lines) {
    const match = line.match(/<!--\s*project:\s*(\S+)\s*-->/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

// v2.5追加: ファイル名から指示書パターンを判定する
// mission/M-/指示書 等のパターンにマッチするかチェック
function isMissionLikeFile(fileName) {
  const lower = fileName.toLowerCase();
  return /^m[-_]/.test(lower) ||
         /mission/i.test(fileName) ||
         /指示書/.test(fileName) ||
         /指示/.test(fileName);
}

// v2.5改修 v2.6修正: スマート振り分けロジック
// ヘッダーに頼らず中身を多段階で判定し、正しいプロジェクトフォルダに配達する
// 優先順位:
//   ① destタグ明示指定 → そのまま従う
//   ② missionタグあり → missions/{project}/ に配達
//   ③ projectタグあり → missions/{project}/ に配達(missionタグ自動注入予約)
//   ④ キーワードルーティング(capsule/ideas等)← v2.6で指示書判定より先に評価
//   ⑤ 指示書っぽいファイル名だがタグなし → inbox/unvalidated/ + LINE聞き返し予約
//   ⑥ デフォルト inbox/
function resolveDestination(fileName, content) {
  // ① destタグ明示指定(最優先)
  const destTag = extractDestFromContent(content);
  if (destTag) {
    // v2.5追加: dest=missions/inbox でも missionタグがあれば正しいフォルダに振り替え
    if (destTag === 'missions/inbox') {
      const missionTag = extractMissionTag(content);
      if (missionTag && VALID_PROJECTS.includes(missionTag)) {
        return { dest: `missions/${missionTag}`, method: 'dest-tag+mission-redirect' };
      }
      const projectTag = extractProjectTag(content);
      if (projectTag && VALID_PROJECTS.includes(projectTag)) {
        return { dest: `missions/${projectTag}`, method: 'dest-tag+project-redirect', needsMissionTag: true, project: projectTag };
      }
    }
    return { dest: destTag, method: 'dest-tag' };
  }

  // ② missionタグあり → 直接プロジェクトフォルダへ
  const missionTag = extractMissionTag(content);
  if (missionTag && VALID_PROJECTS.includes(missionTag)) {
    return { dest: `missions/${missionTag}`, method: 'mission-tag' };
  }

  // ③ projectタグあり → プロジェクトフォルダへ(missionタグ自動注入予約)
  const projectTag = extractProjectTag(content);
  if (projectTag && VALID_PROJECTS.includes(projectTag)) {
    return { dest: `missions/${projectTag}`, method: 'project-tag', needsMissionTag: true, project: projectTag };
  }

  // ④ キーワードルーティング(capsule等)— v2.6修正: 指示書判定より先に評価
  // M_CURRENT_...MASTER_... のようなファイルが /^m[-_]/ で誤判定されるのを防ぐ
  const keywordDest = classifyFile(fileName);
  if (keywordDest) {
    // v2.5追加: キーワードで missions/inbox に飛ばされる場合もスマート判定
    if (keywordDest === 'missions/inbox') {
      // missionタグ・projectタグは②③で処理済みなので、ここに来るのはタグなし指示書
      return { dest: 'inbox/unvalidated', method: 'keyword-mission-no-tag', needsAsk: true };
    }
    return { dest: keywordDest, method: 'keyword' };
  }

  // ⑤ 指示書っぽいファイル名だがタグなし → 聞き返し予約
  // v2.6修正: キーワードに該当しなかった場合のみ指示書判定を実行
  if (isMissionLikeFile(fileName)) {
    return { dest: 'inbox/unvalidated', method: 'mission-like-no-tag', needsAsk: true };
  }
}

// ============================================================
// LINEからファイルをダウンロード(v1.1から変更なし)
// ============================================================

async function downloadFileFromLine(env, messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
    }
  });
  if (!resp.ok) {
    throw new Error(`LINE Content API error: ${resp.status}`);
  }
  const content = await resp.text();
  return content;
}

// ============================================================
// GitHub API操作
// ============================================================

// GitHub Contents APIでファイルをpushする(v1.0から変更なし)
async function pushToGitHub(env, filePath, content, commitMessage) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const b64 = btoa(unescape(encodeURIComponent(content)));

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cocomi-worker'
    },
    body: JSON.stringify({
      message: commitMessage,
      content: b64
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GitHub API error: ${resp.status} - ${errBody}`);
  }
  return await resp.json();
}

// v1.1追加: 既存ファイルのSHAを取得する(上書き更新に必要)
async function getFileSha(env, filePath) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'cocomi-worker'
    }
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error (SHA取得): ${resp.status}`);
  const data = await resp.json();
  return data.sha;
}

// v1.1追加: ファイルをpush(新規 or 上書き自動判定)
async function pushFileToGitHub(env, filePath, content, commitMessage) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const b64 = btoa(unescape(encodeURIComponent(content)));
  const sha = await getFileSha(env, filePath);

  const body = { message: commitMessage, content: b64 };
  if (sha) body.sha = sha;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cocomi-worker'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`GitHub API error: ${resp.status} - ${errBody}`);
  }
  return await resp.json();
}

// ============================================================
// v2.4追加: ファイル名ユーティリティ(日付抽出&表示名短縮)
// ============================================================

// v2.4追加: ファイル名のどこかにあるYYYY-MM-DD形式の日付を抽出する
// 例: "2026-02-26_思い出カプセル_DIFF.md" → "2026-02-26"
// 例: "capsule_DIFF_2026-02-25_01.md" → "2026-02-25"
// 例: "思い出カプセル_DIFF_総合_2026-02-26_03.md" → "2026-02-26"
// 例: "README.md" → null
function extractDateFromName(name) {
  const match = name.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// v2.4追加: LINEボタン用にファイル名だけ表示(日付は別行で表示するため除去)
// 例: "2026-02-26_思い出カプセル_DIFF_総合_03.md" → "思い出カプセル_DIFF_総合_03"
// 例: "capsule_DIFF_2026-02-25_01.md" → "capsule_DIFF_01"
function shortenFileNameOnly(name) {
  // 拡張子を除去
  let display = name.replace(/\.(md|txt|json|js|html|csv)$/i, '');

  // YYYY-MM-DD日付部分を除去
  display = display.replace(/[_-]?\d{4}-\d{2}-\d{2}[_-]?/, '_');

  // 連続するアンダースコア/ハイフンを1つに
  display = display.replace(/[_-]{2,}/g, '_');
  // 先頭・末尾のアンダースコアやハイフンを除去
  display = display.replace(/^[_-]+|[_-]+$/g, '');

  // ボタンラベルの最大文字数(Flex Messageのbutton labelは全角約20文字が目安)
  if (display.length > 30) {
    display = display.substring(0, 29) + '…';
  }

  return display;
}

// v2.4追加: LINEボタン用にファイル名を短く整形する(shortenDisplayNameは後方互換用に残す)
// ファイル名から日付・拡張子を抽出し、短い表示名を生成
// 例: "2026-02-26_思い出カプセル_DIFF_総合_03.md" → "📝 02-26 思い出カプセル_DIFF_総合_03"
// 例: "capsule_DIFF_2026-02-25_01.md" → "📝 02-25 capsule_DIFF_01"
// 例: "M_2026-02-26_思い出カプセル_MASTER.md" → "📝 02-26 思い出カプセル_MASTER"
function shortenDisplayName(name) {
  // 拡張子を除去
  let display = name.replace(/\.(md|txt|json|js|html|csv)$/i, '');

  // YYYY-MM-DD日付を抽出
  const dateMatch = display.match(/(\d{4})-(\d{2})-(\d{2})/);
  let datePrefix = '';
  if (dateMatch) {
    // MM-DD形式に短縮(西暦省略でスペース節約)
    datePrefix = `${dateMatch[2]}-${dateMatch[3]} `;
    // ファイル名から日付部分を除去(前後の区切り文字も1つ除去)
    display = display.replace(/[_-]?\d{4}-\d{2}-\d{2}[_-]?/, '_');
  }

  // 連続するアンダースコア/ハイフンを1つに
  display = display.replace(/[_-]{2,}/g, '_');
  // 先頭・末尾のアンダースコアやハイフンを除去
  display = display.replace(/^[_-]+|[_-]+$/g, '');

  // 長すぎる場合は切る(日付プレフィックス込みで30文字目安)
  const maxLen = 28 - datePrefix.length;
  if (display.length > maxLen) {
    display = display.substring(0, maxLen - 1) + '…';
  }

  return `📝 ${datePrefix}${display}`;
}

// ============================================================
// GitHub フォルダ一覧取得(v1.1 + v1.4強化)
// ============================================================

// v1.1追加: GitHubフォルダの一覧を取得する(ファイルのみ)
// v2.4改善: ファイル名から日付を抽出してソート(命名規則がバラバラでもOK)
async function listGitHubFolder(env, folderPath) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${folderPath}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'cocomi-worker'
    }
  });
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();
  const files = Array.isArray(data) ? data.filter(item => item.type === 'file') : [];
  // v2.4改善: ファイル名から日付を抽出してソート(日付なしファイルは末尾)
  files.sort((a, b) => {
    const dateA = extractDateFromName(a.name);
    const dateB = extractDateFromName(b.name);
    // 両方日付あり → 日付降順
    if (dateA && dateB) return dateB.localeCompare(dateA);
    // 片方だけ日付あり → 日付ありが先
    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;
    // 両方日付なし → ファイル名降順
    return b.name.localeCompare(a.name);
  });
  return files;
}

// v1.4追加: GitHubフォルダの全アイテム(ファイル+サブフォルダ)を取得する
async function listGitHubFolderAll(env, folderPath) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${folderPath}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'cocomi-worker'
    }
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

// v1.4追加: Git Trees APIでリポジトリ全体のツリーを1回で取得する
async function getRepoTree(env) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/main?recursive=1`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'cocomi-worker'
    }
  });
  if (!resp.ok) throw new Error(`GitHub Trees API error: ${resp.status}`);
  const data = await resp.json();
  return data.tree || [];
}

// v1.4追加: ツリーデータからフォルダ構造を組み立てる
function buildFolderSummary(tree) {
  const summary = {};

  for (const item of tree) {
    const parts = item.path.split('/');
    const topFolder = parts[0];

    if (!TOP_LEVEL_FOLDERS.includes(topFolder)) continue;

    if (!summary[topFolder]) {
      summary[topFolder] = { fileCount: 0, subFolders: {} };
    }

    if (parts.length === 2 && item.type === 'blob') {
      summary[topFolder].fileCount++;
    } else if (parts.length >= 2) {
      const subFolder = parts[1];
      if (!summary[topFolder].subFolders[subFolder]) {
        summary[topFolder].subFolders[subFolder] = { fileCount: 0, subFolders: {} };
      }

      if (parts.length === 3 && item.type === 'blob') {
        summary[topFolder].subFolders[subFolder].fileCount++;
      } else if (parts.length >= 3) {
        const subSubFolder = parts[2];
        if (!summary[topFolder].subFolders[subFolder].subFolders[subSubFolder]) {
          summary[topFolder].subFolders[subFolder].subFolders[subSubFolder] = { fileCount: 0 };
        }
        if (parts.length === 4 && item.type === 'blob') {
          summary[topFolder].subFolders[subFolder].subFolders[subSubFolder].fileCount++;
        }
      }
    }
  }

  return summary;
}

// ============================================================
// v2.1追加: GitHubファイル内容取得(読むコマンド用)
// ============================================================

// v2.1追加: GitHubからファイルの中身を取得してテキストで返す
async function readFileFromGitHub(env, filePath) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'cocomi-worker'
    }
  });

  if (resp.status === 404) return { error: 'not_found' };
  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);

  const data = await resp.json();

  // ディレクトリの場合
  if (Array.isArray(data) || data.type === 'dir') {
    return { error: 'is_directory', path: filePath };
  }

  // Base64デコード(UTF-8対応)
  const cleaned = (data.content || '').replace(/\n/g, '');
  const bytes = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));
  const content = new TextDecoder('utf-8').decode(bytes);

  return { content, size: content.length };
}

// ============================================================
// LINE返信
// ============================================================

async function replyToLine(env, replyToken, message) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: message }]
    })
  });
}

// v2.2追加: Flex Messageで返信する
async function replyFlexToLine(env, replyToken, altText, flexContents) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken: replyToken,
      messages: [{
        type: 'flex',
        altText: altText,
        contents: flexContents
      }]
    })
  });
}

// v2.2追加: ファイル一覧をタップ可能なFlex Messageに変換する
// v2.3修正: ページネーション対応(page引数、「もっと見る」ボタン追加)
// ファイルをタップすると「読む フォルダパス/ファイル名」が自動送信される
function buildFileListFlex(title, emoji, sections, moreCommand) {
  // sectionsは [{label, files: [{name, path}], total}] の配列
  // moreCommandは「もっと見る」ボタンで送信するテキスト(nullならボタンなし)
  const bodyContents = [
    {
      type: 'text',
      text: `${emoji} ${title}`,
      weight: 'bold',
      size: 'lg',
      color: '#1a1a2e'
    },
    { type: 'separator', margin: 'md' }
  ];

  for (const section of sections) {
    // セクションヘッダー
    const totalLabel = section.total !== undefined ? ` (${section.total}件)` : '';
    bodyContents.push({
      type: 'text',
      text: `${section.label}${totalLabel}`,
      weight: 'bold',
      size: 'sm',
      color: '#666666',
      margin: 'lg'
    });

    // ファイルボタン(v2.4改善: 日付ラベル+ファイル名ボタンの2段構成)
    let lastDate = ''; // 同じ日付の連続表示を避ける
    for (const file of section.files) {
      // 日付を抽出
      const fileDate = extractDateFromName(file.name);
      const dateLabelText = fileDate
        ? `${fileDate.substring(5)}` // MM-DD形式
        : '';

      // 日付が前のファイルと違う場合のみ日付ラベルを表示
      if (dateLabelText && dateLabelText !== lastDate) {
        bodyContents.push({
          type: 'text',
          text: `📅 ${dateLabelText}`,
          size: 'xs',
          color: '#1a8f5c',
          weight: 'bold',
          margin: 'md'
        });
        lastDate = dateLabelText;
      }

      // ファイル名(日付と拡張子を除去して表示)
      const displayName = shortenFileNameOnly(file.name);

      bodyContents.push({
        type: 'button',
        action: {
          type: 'message',
          label: displayName,
          text: `読む ${file.path}`
        },
        style: 'link',
        height: 'sm',
        margin: 'none'
      });
    }
  }

  // v2.3追加:「もっと見る」ボタン
  if (moreCommand) {
    bodyContents.push({ type: 'separator', margin: 'lg' });
    bodyContents.push({
      type: 'button',
      action: {
        type: 'message',
        label: '📂 もっと見る',
        text: moreCommand
      },
      style: 'primary',
      height: 'sm',
      margin: 'md',
      color: '#1a8f5c'
    });
  }

  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
      paddingAll: '16px'
    }
  };
}

// v2.2追加: フォルダ内のファイル+サブフォルダをFlex Messageに変換する
function buildFolderContentsFlex(folderPath, dirs, files) {
  const bodyContents = [
    {
      type: 'text',
      text: `📂 ${folderPath}/`,
      weight: 'bold',
      size: 'lg',
      color: '#1a1a2e'
    },
    { type: 'separator', margin: 'md' }
  ];

  // サブフォルダ
  if (dirs.length > 0) {
    bodyContents.push({
      type: 'text',
      text: `📁 フォルダ (${dirs.length}個)`,
      weight: 'bold',
      size: 'sm',
      color: '#666666',
      margin: 'lg'
    });
    for (const dir of dirs) {
      bodyContents.push({
        type: 'button',
        action: {
          type: 'message',
          label: `📂 ${dir.name}/`,
          text: `フォルダ ${folderPath}/${dir.name}`
        },
        style: 'link',
        height: 'sm',
        margin: 'none'
      });
    }
  }

  // ファイル
  if (files.length > 0) {
    bodyContents.push({
      type: 'text',
      text: `📄 ファイル (${files.length}件)`,
      weight: 'bold',
      size: 'sm',
      color: '#666666',
      margin: 'lg'
    });
    const displayFiles = files.slice(-15);
    let lastDate = '';
    for (const f of displayFiles) {
      // v2.4改善: 日付ラベル+ファイル名ボタンの2段構成
      const fileDate = extractDateFromName(f.name);
      const dateLabelText = fileDate ? fileDate.substring(5) : '';

      if (dateLabelText && dateLabelText !== lastDate) {
        bodyContents.push({
          type: 'text',
          text: `📅 ${dateLabelText}`,
          size: 'xs',
          color: '#1a8f5c',
          weight: 'bold',
          margin: 'md'
        });
        lastDate = dateLabelText;
      }

      const displayName = shortenFileNameOnly(f.name);
      bodyContents.push({
        type: 'button',
        action: {
          type: 'message',
          label: displayName,
          text: `読む ${folderPath}/${f.name}`
        },
        style: 'link',
        height: 'sm',
        margin: 'none'
      });
    }
    if (files.length > 15) {
      bodyContents.push({
        type: 'text',
        text: `  ...他${files.length - 15}件`,
        size: 'xs',
        color: '#999999',
        margin: 'sm'
      });
    }
  }

  if (dirs.length === 0 && files.length === 0) {
    bodyContents.push({
      type: 'text',
      text: '(空のフォルダです)',
      size: 'sm',
      color: '#999999',
      margin: 'lg'
    });
  }

  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
      paddingAll: '16px'
    }
  };
}

// ============================================================
// ファイルメッセージの処理(v1.1 + v1.3 + v2.0強化)
// ============================================================

// v2.0修正: missions/に配達されるファイルにmissionタグ検証を追加
// v2.5改修: スマート振り分け対応のファイルメッセージ処理
async function handleFileMessage(env, event) {
  const messageId = event.message.id;
  const fileName = event.message.fileName || 'unknown.md';
  const replyToken = event.replyToken;

  console.log(`📁 ファイル受信: ${fileName} (messageId: ${messageId})`);

  let content = await downloadFileFromLine(env, messageId);
  const routing = resolveDestination(fileName, content);
  let { dest: destFolder, method } = routing;

  console.log(`📂 ルーティング: ${method} → ${destFolder}`);

  // v2.5追加: projectタグのみでmissionタグがない場合、自動注入する
  if (routing.needsMissionTag && routing.project) {
    const missionHeader = `<!-- mission: ${routing.project} -->`;
    if (!extractMissionTag(content)) {
      content = missionHeader + '\n' + content;
      console.log(`🛡️ missionタグ自動注入: ${routing.project}`);
    }
  }

  // v2.5追加: 指示書っぽいがタグなし → inbox退避 + 聞き返し
  if (routing.needsAsk) {
    const askFilePath = `${destFolder}/${fileName}`;
    const commitMsg = `📥 未検証指示書退避: ${fileName}`;
    await pushFileToGitHub(env, askFilePath, content, commitMsg);

    await replyToLine(env, replyToken,
      `📥 ファイルをinboxに保管しました。\n\n` +
      `📄 ファイル: ${fileName}\n\n` +
      `🤔 指示書として実行したい場合は、ファイルの先頭にヘッダーを追加してね:\n\n` +
      `<!-- mission: プロジェクト名 -->\n\n` +
      `またはLINEテキストで直接指示もOK:\n` +
      `例: genba-pro: ログイン画面の色を変更\n\n` +
      `📂 使えるプロジェクト名:\n` +
      `  ${VALID_PROJECTS.join(', ')}`
    );
    console.log(`📥 未検証指示書退避: ${askFilePath} (${method})`);
    return;
  }

  // v2.5追加: missions/配達時、ファイル名にM-プレフィックスがなければ自動リネーム
  let finalFileName = fileName;
  if (destFolder.startsWith('missions/') && !fileName.startsWith('M-')) {
    const missionId = generateMissionId();
    const sanitized = sanitizeForFilename(fileName.replace(/\.(md|txt)$/i, ''));
    finalFileName = `${missionId}-${sanitized}.md`;
    console.log(`📝 指示書リネーム: ${fileName} → ${finalFileName}`);
  }

  const filePath = `${destFolder}/${finalFileName}`;

  // v2.0追加: missions/配達時にmissionタグの有無を最終確認
  let safetyWarning = '';
  if (destFolder.startsWith('missions/')) {
    const missionTag = extractMissionTag(content);
    if (!missionTag) {
      safetyWarning = '\n\n⚠️ <!-- mission: project-id --> ヘッダーがありません。\nタブレットのバリデーションで実行拒否される可能性があります。\nクロちゃんに確認してね!';
    }
  }

  let emoji = '📦';
  let action = '保管';
  if (destFolder.startsWith('capsules/')) {
    emoji = '💊';
    action = 'カプセル保管';
  } else if (destFolder.startsWith('missions/')) {
    emoji = '📋';
    action = '指示書配達';
  } else if (destFolder.startsWith('ideas')) {
    emoji = '💡';
    action = 'アイデア保管';
  } else if (destFolder.startsWith('dev-capsules')) {
    emoji = '🔧';
    action = '開発メモ保管';
  }

  const commitMessage = `${emoji} LINE配達: ${finalFileName}`;
  await pushFileToGitHub(env, filePath, content, commitMessage);

  // v2.5改善: ルーティング情報をより詳細に
  let routingInfo = '';
  switch (method) {
    case 'keyword':
      routingInfo = '🏷️ ファイル名から自動判定'; break;
    case 'dest-tag':
      routingInfo = '🎯 dest指定で配置'; break;
    case 'dest-tag+mission-redirect':
      routingInfo = '🎯 dest指定 → 🛡️ missionタグでプロジェクト振替'; break;
    case 'dest-tag+project-redirect':
      routingInfo = '🎯 dest指定 → 📂 projectタグで振替 + missionタグ自動注入'; break;
    case 'mission-tag':
      routingInfo = '🛡️ missionタグから自動振り分け'; break;
    case 'project-tag':
      routingInfo = '📂 projectタグから自動振り分け + missionタグ自動注入'; break;
    default:
      routingInfo = '📥 デフォルト(inbox)\n\n💡 自動振り分けヒント:\nファイル名に以下を含めると自動で振り分けるよ!\n📋 DIFF/MASTER → カプセル\n📝 企画書/計画書 → 企画書\n💡 アイデア/TODO → アイデア保管庫\n📓 メモ/ノート → デイリー';
  }

  // v2.5追加: リネーム情報
  let renameInfo = '';
  if (finalFileName !== fileName) {
    renameInfo = `\n📝 リネーム: ${finalFileName}`;
  }

  const replyMessage = `${emoji} ${action}完了!\n\n📂 保管先: ${filePath}\n📄 ファイル: ${fileName}${renameInfo}\n📏 サイズ: 約${content.length}文字\n${routingInfo}\n\nGitHubに安全に保管しました!🔒${safetyWarning}`;

  await replyToLine(env, replyToken, replyMessage);
  console.log(`✅ ${action}完了: ${filePath} (${method})`);
}

// ============================================================
// v1.5改善: テキスト正規化&コマンド判定の柔軟化
// ============================================================

// v1.5追加: テキストを正規化する(全角スペース→半角、前後トリム)
function normalizeText(text) {
  return text.trim().replace(/\u3000/g, ' ');
}

// v1.5追加: 「フォルダ」系コマンドからパスを抽出する
function extractFolderPath(text) {
  const match = text.match(/^フォルダ[\s]*(.+)$/);
  if (match) {
    return match[1].trim().replace(/^\/+|\/+$/g, '');
  }
  return null;
}

// v1.5改善: コマンド判定(表記揺れ対応強化版)
async function handleCommand(env, event) {
  const raw = event.message.text.trim();
  const text = normalizeText(raw);

  // --- 「状態」コマンド(v2.1: バージョン表示更新)---
  const statusAliases = ['状態', 'じょうたい', 'ステータス', 'status', 'ポストマン', 'postman'];
  if (statusAliases.includes(text.toLowerCase())) {
    await replyToLine(env, event.replyToken,
      '🐾 COCOMI Worker v2.6 稼働中!\n\n' +
      '📋 テキスト指示: 「プロジェクト名: 指示内容」\n' +
      '📁 ファイル配達: .mdファイルを送信\n' +
      '💊 カプセル保管: カプセルファイルを送信→自動判定→GitHub保管\n' +
      '💡 アイデア保管: アイデア/TODOファイル→ideas/に自動振り分け\n' +
      '🎯 dest指定: ファイル先頭に <!-- dest: パス --> で配置先指定可能\n' +
      '📂 フォルダ一覧: 「フォルダ一覧」で全体構造を表示\n' +
      '🔍 フォルダ確認: 「フォルダ ○○」で中身を確認\n' +
      '📖 ファイル表示: 「読む ○○」でファイル内容を表示\n' +
      '❓ ヘルプ: 「ヘルプ」でコマンド一覧\n\n' +
      '🛡️ v2.0: 安全バリデーション\n' +
      '🆕 v2.4: 日付抽出ソート&ボタン表示名短縮\n' +
      '🆕 v2.6: キーワード振り分け強化(アイデア/メモ/計画書+inboxガイド)'
    );
    return true;
  }

  // --- v2.1追加: 「ヘルプ 指示」コマンド(「ヘルプ」より先に判定)---
  const helpInstructAliases = ['ヘルプ 指示', 'ヘルプ指示', 'help 指示'];
  if (helpInstructAliases.includes(text.toLowerCase())) {
    await replyToLine(env, event.replyToken,
      '📝 指示の送り方ガイド\n\n' +
      '【簡単な修正】テキストで送る\n' +
      '  書き方: プロジェクト名: やりたいこと\n' +
      '  例: genba-pro: ログイン画面の色を青に\n' +
      '  例: culo-chan: 合計欄のバグを直して\n' +
      '  ※プロジェクト名省略 → inboxに保管\n\n' +
      '【複雑な修正】ファイルで送る\n' +
      '  ① クロちゃんに指示書を作ってもらう\n' +
      '  ② .mdファイルをLINEで送信\n' +
      '  ③ 自動で実行→CI→完了通知\n\n' +
      '【カプセル保管】ファイル名で自動判定\n' +
      '  思い出カプセル → capsules/daily/\n' +
      '  MASTER → capsules/master/\n' +
      '  企画書 → capsules/plans/\n\n' +
      '【ファイルの中身を読む】\n' +
      '  読む capsules/daily/ファイル名.md\n\n' +
      `📂 使えるプロジェクト名:\n  ${VALID_PROJECTS.join(', ')}`
    );
    return true;
  }

  // --- v2.1追加: 「ヘルプ」コマンド ---
  const helpAliases = ['ヘルプ', 'へるぷ', 'help', '?', '?'];
  if (helpAliases.includes(text.toLowerCase())) {
    await replyToLine(env, event.replyToken,
      '📮 COCOMI Postman コマンド一覧\n\n' +
      '📊 状態 — システムバージョン・機能一覧\n' +
      '💊 カプセル — カプセル保管庫の中身\n' +
      '💡 アイデア一覧 — アイデア保管庫の中身\n' +
      '📂 フォルダ一覧 — 全フォルダ構造\n' +
      '📂 フォルダ ○○ — 指定フォルダの中身\n' +
      '📖 読む ○○ — ファイルの中身を表示\n' +
      '❓ ヘルプ — このメッセージ\n' +
      '📝 ヘルプ 指示 — 指示の送り方ガイド\n\n' +
      '📝 指示の送り方:\n' +
      '  テキスト → プロジェクト名: 指示内容\n' +
      '  ファイル → .mdファイルを送信\n\n' +
      '対応プロジェクト:\n' +
      `  ${VALID_PROJECTS.join(' / ')}\n\n` +
      '💡 リッチメニューからもボタンで操作できます'
    );
    return true;
  }

  // --- v2.1追加: 「読む」コマンド ---
  if (text.startsWith('読む') || text.toLowerCase().startsWith('read ')) {
    const pathRaw = text.replace(/^(読む|read)\s*/, '').trim().replace(/^\/+/, '');

    if (!pathRaw) {
      await replyToLine(env, event.replyToken,
        '📖 読むコマンドの使い方\n\n' +
        '読む ファイルパス\n\n' +
        '例:\n' +
        '  読む capsules/daily/2026-02-26_DIFF.md\n' +
        '  読む capsules/master/COCOMI-POSTMAN-取扱説明書.md\n' +
        '  読む missions/genba-pro/M-LINE-0226.md\n\n' +
        '💡 「カプセル」や「フォルダ ○○」でファイル名を確認してからコピペすると楽だよ'
      );
      return true;
    }

    try {
      const result = await readFileFromGitHub(env, pathRaw);

      if (result.error === 'not_found') {
        await replyToLine(env, event.replyToken,
          `❌ ファイルが見つかりません\n📄 ${pathRaw}\n\nパスを確認してください。\n「フォルダ一覧」でフォルダ構造を確認できます。`
        );
        return true;
      }

      if (result.error === 'is_directory') {
        await replyToLine(env, event.replyToken,
          `📂 これはフォルダです\n「フォルダ ${pathRaw}」で中身を確認できます。`
        );
        return true;
      }

      const MAX_CHARS = 4800;
      let replyText;
      if (result.size <= 5000) {
        replyText = `📖 ファイル内容\n📄 ${pathRaw}\n━━━━━━━━━━━━━━━\n${result.content}\n━━━━━━━━━━━━━━━\n📏 ${result.size}文字`;
      } else {
        const truncated = result.content.substring(0, MAX_CHARS);
        replyText = `📖 ファイル内容(先頭${MAX_CHARS}文字)\n📄 ${pathRaw}\n━━━━━━━━━━━━━━━\n${truncated}\n...(全${result.size}文字中、先頭${MAX_CHARS}文字を表示)\n━━━━━━━━━━━━━━━`;
      }

      await replyToLine(env, event.replyToken, replyText);
    } catch (err) {
      console.error('読むコマンドエラー:', err);
      await replyToLine(env, event.replyToken,
        `❌ ファイル読み込みエラー\n${err.message.substring(0, 100)}`
      );
    }
    return true;
  }

  // --- 「カプセル」コマンド(v2.4: 全ファイル日付順ごちゃまぜ + 表示名短縮)---
  const capsuleMatch = text.match(/^(カプセル|かぷせる|capsule|capsules)(\s+(\d+))?$/i);
  if (capsuleMatch) {
    const page = parseInt(capsuleMatch[3] || '1', 10);
    const PER_PAGE = 10;
    const offset = (page - 1) * PER_PAGE;

    try {
      const dailyList = await listGitHubFolder(env, 'capsules/daily');
      const masterList = await listGitHubFolder(env, 'capsules/master');
      const plansList = await listGitHubFolder(env, 'capsules/plans');

      // v2.4改善: 全ファイルをフラットに結合し、日付抽出ソートで新しい順に
      const allFiles = [
        ...dailyList.map(f => ({ name: f.name, path: `capsules/daily/${f.name}`, section: 'daily' })),
        ...masterList.map(f => ({ name: f.name, path: `capsules/master/${f.name}`, section: 'master' })),
        ...plansList.map(f => ({ name: f.name, path: `capsules/plans/${f.name}`, section: 'plans' }))
      ];

      // 日付抽出で全体ソート(セクション無関係に新しい順)
      allFiles.sort((a, b) => {
        const dateA = extractDateFromName(a.name);
        const dateB = extractDateFromName(b.name);
        if (dateA && dateB) return dateB.localeCompare(dateA);
        if (dateA && !dateB) return -1;
        if (!dateA && dateB) return 1;
        return b.name.localeCompare(a.name);
      });

      const totalFiles = allFiles.length;

      if (totalFiles === 0) {
        await replyToLine(env, event.replyToken,
          '📦 カプセル保管庫はまだ空です。\nファイルを送信して保管を始めよう!'
        );
        return true;
      }

      // ページ分のファイルを取得
      const pageFiles = allFiles.slice(offset, offset + PER_PAGE);

      if (pageFiles.length === 0) {
        await replyToLine(env, event.replyToken,
          `📦 カプセル保管庫 — ページ${page}にはファイルがありません。`
        );
        return true;
      }

      // v2.4改善: セクション別ではなく1つのリストとして表示
      // ただしファイル名の横にセクション情報を小さく表示
      const sectionTag = { 'daily': '📅', 'master': '📚', 'plans': '📋' };
      const sections = [{
        label: `📅${dailyList.length} 📚${masterList.length} 📋${plansList.length}`,
        files: pageFiles.map(f => ({
          name: f.name,
          path: f.path,
          sectionEmoji: sectionTag[f.section] || ''
        }))
      }];

      // 「もっと見る」ボタン(次ページがあるか判定)
      const hasMore = offset + PER_PAGE < totalFiles;
      const moreCommand = hasMore ? `カプセル ${page + 1}` : null;

      const pageLabel = totalFiles > PER_PAGE
        ? `カプセル保管庫 (${offset + 1}〜${Math.min(offset + PER_PAGE, totalFiles)} / 全${totalFiles}件)`
        : 'カプセル保管庫';

      const flex = buildFileListFlex(pageLabel, '💊', sections, moreCommand);
      await replyFlexToLine(env, event.replyToken, 'カプセル保管庫', flex);
    } catch (err) {
      console.error('カプセル一覧取得エラー:', err);
      await replyToLine(env, event.replyToken,
        '📦 カプセル保管庫はまだ空です。\nファイルを送信して保管を始めよう!'
      );
    }
    return true;
  }

  // --- 「アイデア一覧」コマンド(v1.5: 表記揺れ追加)---
  const ideaAliases = [
    'アイデア一覧', 'アイディア一覧', 'アイデア', 'アイディア',
    'ideas', 'idea', 'あいであ'
  ];
  if (ideaAliases.includes(text.toLowerCase())) {
    try {
      const categories = ['app', 'business', 'cocomi', 'other'];
      let reply = '💡 アイデア保管庫の状態\n\n';
      let totalCount = 0;

      for (const cat of categories) {
        const files = await listGitHubFolder(env, `capsules/ideas/${cat}`);
        const count = files.length;
        totalCount += count;
        const catEmoji = cat === 'app' ? '📱' : cat === 'business' ? '💼' : cat === 'cocomi' ? '🐾' : '📦';
        reply += `${catEmoji} ${cat}/ (${count}件)\n`;
        for (const f of files) {
          const name = f.name.replace('.md', '').substring(0, 40);
          reply += `  • ${name}\n`;
        }
        reply += '\n';
      }

      reply += `合計: ${totalCount}件のアイデア 🌟`;
      await replyToLine(env, event.replyToken, reply);
    } catch (err) {
      console.error('アイデア一覧取得エラー:', err);
      await replyToLine(env, event.replyToken,
        '💡 アイデア保管庫はまだ空です。\n「アイデア app: 〇〇」で保管できるよ!'
      );
    }
    return true;
  }

  // --- v1.5改善: 「フォルダ」系コマンド(統合判定)---
  if (text.startsWith('フォルダ') || text === 'folders') {

    // 「フォルダ一覧」判定
    const folderListAliases = [
      'フォルダ一覧', 'フォルダいちらん', 'ふぉるだ一覧', 'folders'
    ];
    if (folderListAliases.includes(text.toLowerCase()) || text === 'フォルダ') {
      try {
        const tree = await getRepoTree(env);
        const summary = buildFolderSummary(tree);

        let reply = '📁 COCOMI保管庫 フォルダ一覧\n\n';

        for (const topFolder of TOP_LEVEL_FOLDERS) {
          const data = summary[topFolder];
          if (!data) continue;

          let icon = '📂';
          if (topFolder === 'missions') icon = '📋';
          else if (topFolder === 'capsules') icon = '💊';
          else if (topFolder === 'inbox') icon = '📥';
          else if (topFolder === 'reports') icon = '📊';
          else if (topFolder === 'errors') icon = '⚠️';
          else if (topFolder === 'ideas') icon = '💡';
          else if (topFolder === 'templates') icon = '📝';

          reply += `${icon} ${topFolder}/`;
          if (data.fileCount > 0) reply += ` (${data.fileCount}件)`;
          reply += '\n';

          const subNames = Object.keys(data.subFolders);
          for (const subName of subNames) {
            const sub = data.subFolders[subName];
            reply += `  ├── ${subName}/`;
            if (sub.fileCount > 0) reply += ` (${sub.fileCount}件)`;
            reply += '\n';

            const subSubNames = Object.keys(sub.subFolders);
            for (const ssName of subSubNames) {
              const ss = sub.subFolders[ssName];
              reply += `  │   └── ${ssName}/ (${ss.fileCount}件)\n`;
            }
          }
          reply += '\n';
        }

        reply += '🔍 詳しく見るには「フォルダ ○○」と送ってね\n';
        reply += '※ スペースなしでもOK!例: 「フォルダcapsules/daily」';

        await replyToLine(env, event.replyToken, reply);
      } catch (err) {
        console.error('フォルダ一覧取得エラー:', err);
        await replyToLine(env, event.replyToken,
          '📁 フォルダ一覧の取得に失敗しました。\nもう一度試してみてください。'
        );
      }
      return true;
    }

    // 「フォルダ ○○」(中身確認)— v2.2: Flex Message対応
    const targetPath = extractFolderPath(text);
    if (targetPath) {
      try {
        const items = await listGitHubFolderAll(env, targetPath);

        if (!items) {
          await replyToLine(env, event.replyToken,
            `📁 「${targetPath}」フォルダは見つかりませんでした。\n\n「フォルダ一覧」で存在するフォルダを確認してみてね。`
          );
          return true;
        }

        const dirs = items.filter(i => i.type === 'dir');
        const files = items.filter(i => i.type === 'file');

        const flex = buildFolderContentsFlex(targetPath, dirs, files);
        await replyFlexToLine(env, event.replyToken, `${targetPath}の中身`, flex);
      } catch (err) {
        console.error('フォルダ中身取得エラー:', err);
        await replyToLine(env, event.replyToken,
          `📁 「${targetPath}」の取得に失敗しました。\nパスを確認してもう一度試してみてね。`
        );
      }
      return true;
    }

    return true;
  }

  return false;
}

// ============================================================
// メインハンドラ
// ============================================================

export default {
  async fetch(request, env) {

    // GETリクエスト → ヘルスチェック(v2.0更新)
    if (request.method === 'GET') {
      return new Response('🐾 COCOMI Worker is alive! v2.5\n📁 全機能対応\n🆕 v2.5: スマート振り分け&missionタグ自動注入', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const signature = request.headers.get('x-line-signature');
      const body = await request.text();

      if (!signature || !await verifySignature(body, signature, env.LINE_CHANNEL_SECRET)) {
        return new Response('Unauthorized', { status: 401 });
      }

      const json = JSON.parse(body);
      const events = json.events || [];

      for (const event of events) {
        if (event.type !== 'message') continue;

        try {
          // ファイルメッセージの処理
          if (event.message.type === 'file') {
            await handleFileMessage(env, event);
            continue;
          }

          // テキストメッセージの処理
          if (event.message.type === 'text') {
            // コマンド判定(v1.5: 柔軟な判定)
            const isCommand = await handleCommand(env, event);
            if (isCommand) continue;

            // v2.0修正: テキスト指示のバリデーション強化
            const { project, instruction, valid } = parseInstruction(event.message.text);

            if (!valid) {
              // v2.0追加: プロジェクト名なし → inboxに退避&ガイド返信
              const missionId = generateMissionId();
              const sanitized = sanitizeForFilename(instruction);
              const inboxPath = `inbox/unvalidated/${missionId}-${sanitized}.md`;
              const inboxContent = `<!-- unvalidated: true -->\n# 未検証テキスト\n## 受信日時: ${new Date().toISOString()}\n\n${instruction}\n`;
              const commitMsg = `📥 未検証テキスト退避: ${instruction.substring(0, 20)}`;

              await pushToGitHub(env, inboxPath, inboxContent, commitMsg);

              await replyToLine(env, event.replyToken,
                `📥 テキストをinboxに保管しました。\n\n` +
                `🛡️ 指示として実行するには、プロジェクト名を付けて送ってね:\n\n` +
                `📋 書き方: 「プロジェクト名: やりたいこと」\n\n` +
                `例:\n` +
                `  genba-pro: ログイン画面の色を青に\n` +
                `  culo-chan: 材料名の候補表示バグ修正\n` +
                `  cocomi-postman: 通知メッセージ変更\n\n` +
                `📂 使えるプロジェクト名:\n` +
                `  ${VALID_PROJECTS.join(', ')}`
              );
              continue;
            }

            // 有効なテキスト指示 → missions/に配達(missionタグ自動注入済み)
            const missionId = generateMissionId();
            const sanitized = sanitizeForFilename(instruction);
            const filePath = `missions/${project}/${missionId}-${sanitized}.md`;
            const content = createMissionContent(missionId, project, instruction);
            const commitMessage = `📲 LINE指示: ${project} - ${instruction.substring(0, 30)}`;

            await pushToGitHub(env, filePath, content, commitMessage);

            await replyToLine(env, event.replyToken,
              `📦 指示受付完了!\n\n` +
              `📂 プロジェクト: ${project}\n` +
              `📋 ミッション: ${missionId}\n` +
              `📝 内容: ${instruction.substring(0, 50)}\n` +
              `🛡️ missionタグ: ✅ 自動付与済み\n\n` +
              `タブレットに配達しました!🚚\n` +
              `実行が始まったらLINEで通知するね`
            );
          }
        } catch (err) {
          console.error('Fatal error:', err);
        }
      }

      return new Response('OK', { status: 200 });

    } catch (err) {
      console.error('Fatal error:', err);
      return new Response('OK', { status: 200 });
    }
  }
};
