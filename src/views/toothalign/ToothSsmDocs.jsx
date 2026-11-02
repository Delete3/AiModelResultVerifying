import ApiDocs from '../docs/ApiDocs';

// The AI排牙 API's documents for the orthodontic team, served as static files from
// public/docs/toothssm/ so that one edit there is what the team downloads:
//
//   api.md        the integration guide (endpoints, parameters, results, examples)
//   changelog.md  what changed, newest first -- its first `## <date>　<title>` is "this version"
//
// When the API changes, update both and tell the team to come back here (user, 2026-10-30).
const DOCS = {
  changelog: { url: '/docs/toothssm/changelog.md', label: '更新內容', file: 'AI排牙-API-更新內容' },
  api: { url: '/docs/toothssm/api.md', label: 'API 串接文件', file: 'AI排牙-API-串接說明' },
};

/** The AI排牙 tab's documents: the latest change, and the change log and guide in a dialog. */
const ToothSsmDocs = () => <ApiDocs title='AI排牙 API' docs={DOCS} idPrefix='ssm' />;

export default ToothSsmDocs;
