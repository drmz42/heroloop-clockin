// Version line for the Android app's start and loading screens. WEB_BUILD is filled by
// `git archive` (export-subst in .gitattributes) with the short commit of the deployed build;
// a local checkout keeps the placeholder and shows "dev".
const WEB_BUILD = '$Format:%h$';
const webBuild = WEB_BUILD.startsWith('$') ? 'dev' : WEB_BUILD;
const appVersion = typeof navigator === 'undefined' ? null : /HeroLoopApp\/(\S+)/.exec(navigator.userAgent)?.[1] ?? null;

export const buildVersionLabel = [appVersion && `App ${appVersion}`, `Build ${webBuild}`].filter(Boolean).join(' · ');
