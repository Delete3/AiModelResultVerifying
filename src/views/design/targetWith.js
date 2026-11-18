import { PIPELINE_TARGETS } from '../../utils/function/EzaiPipelineApi';

/**
 * The first target the 牙冠設計 tab offers that has `has(site)`, or undefined -- for the panel to
 * name where an option is when the chosen target lacks it.
 *
 * Its own file rather than an export of EzaiPipelineApi.js: Cloudflare keeps eztest's .js in
 * browsers for 4 hours, and a cached EzaiPipelineApi.js without the export would blank the page.
 */
const targetWith = has => Object.keys(PIPELINE_TARGETS)
  .find(key => !PIPELINE_TARGETS[key].panel && has(PIPELINE_TARGETS[key]));

export default targetWith;
