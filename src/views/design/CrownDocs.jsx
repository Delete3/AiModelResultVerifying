import ApiDocs from '../docs/ApiDocs';

// The crown pipeline's API documents (ezai-pipeline, /pipeline/ on both boxes) for whoever
// integrates it -- HeyGears' caller first -- served as static files from public/docs/crown/
// the same way as the AI排牙 tab's:
//
//   api.md        the integration guide (both boxes, parameters, the archive, crown models)
//   changelog.md  what changed, newest first -- its first `## <date>　<title>` is "this version"
//
// When the pipeline's API changes -- an option, a box gaining one -- update both (user, 2026-11-03).
const DOCS = {
  changelog: { url: '/docs/crown/changelog.md', label: '更新內容', file: '牙冠設計-API-更新內容' },
  api: { url: '/docs/crown/api.md', label: 'API 串接文件', file: '牙冠設計-API-串接說明' },
};

/** The 牙冠設計 tab's documents: the latest change, and the change log and guide in a dialog. */
const CrownDocs = () => <ApiDocs title='牙冠設計 API' docs={DOCS} idPrefix='crown' />;

export default CrownDocs;
