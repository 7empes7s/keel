/**
 * Restore gaps batch 18: which Intune apps KEEL can add again, and how.
 *
 * Graph returns an app's settings but never its package (the installer file),
 * so the kinds split three ways:
 *
 *  - settings: everything the app needs is in its settings (store links, web
 *    links, Microsoft 365 Apps, Edge, WinGet apps). KEEL recreates the app and
 *    assigns it as in the backup.
 *  - packaged: the app installs a file the admin uploaded (Win32, MSI, MSIX,
 *    iOS, Android and macOS line-of-business apps). KEEL recreates the app with
 *    its settings (install commands, detection and requirement rules, return
 *    codes), unassigned, and leaves a step to upload the package. It is
 *    assigned only once the package is uploaded: an assigned app without its
 *    file fails to install on every device.
 *  - synced: the app comes from Apple Business Manager, managed Google Play or
 *    Microsoft, which add it again themselves. KEEL never creates one; it puts
 *    back who an existing one is assigned to.
 *
 * Any other kind is not written. Pure: no imports, no tenant.
 */

export const APP_KINDS = Object.freeze({
  settings: Object.freeze([
    'webApp', 'windowsWebApp', 'iosiPadOSWebClip', 'iosStoreApp', 'androidStoreApp', 'winGetApp',
    'officeSuiteApp', 'macOSOfficeSuiteApp', 'windowsMicrosoftEdgeApp', 'macOSMicrosoftEdgeApp', 'macOSMicrosoftDefenderApp',
  ]),
  packaged: Object.freeze([
    'win32LobApp', 'windowsMobileMSI', 'windowsUniversalAppX', 'windowsAppX', 'iosLobApp', 'androidLobApp',
    'macOSLobApp', 'macOSDmgApp', 'macOSPkgApp',
  ]),
  synced: Object.freeze([
    'iosVppApp', 'macOsVppApp', 'androidManagedStoreApp', 'androidManagedStoreWebApp', 'managedIOSStoreApp', 'managedAndroidStoreApp',
    'managedIOSLobApp', 'managedAndroidLobApp', 'microsoftStoreForBusinessApp', 'windowsStoreApp',
  ]),
});

const BY_KIND = new Map(Object.entries(APP_KINDS).flatMap(([group, kinds]) => kinds.map((kind) => [kind.toLowerCase(), group])));

/** The app's Graph kind without its namespace (win32LobApp), or null. */
export function appKindName(payload) {
  const odata = payload?.['@odata.type'];
  return typeof odata === 'string' ? odata.replace(/^#?microsoft\.graph\./, '') : null;
}

/** 'settings' | 'packaged' | 'synced' | null (a kind KEEL does not write). */
export function appGroupOf(payload) {
  const name = appKindName(payload);
  return name ? BY_KIND.get(name.toLowerCase()) ?? null : null;
}

/** Plain words for an app kind, for steps and refusals. */
export function appKindWords(payload) {
  const name = appKindName(payload);
  return ({
    win32LobApp: 'Windows app (Win32)', windowsMobileMSI: 'Windows MSI line-of-business app', windowsUniversalAppX: 'Windows MSIX/AppX line-of-business app',
    windowsAppX: 'Windows AppX line-of-business app', iosLobApp: 'iOS line-of-business app', androidLobApp: 'Android line-of-business app',
    macOSLobApp: 'macOS line-of-business app', macOSDmgApp: 'macOS DMG app', macOSPkgApp: 'macOS PKG app',
    iosVppApp: 'iOS volume-purchased app', macOsVppApp: 'macOS volume-purchased app', androidManagedStoreApp: 'managed Google Play app',
    androidManagedStoreWebApp: 'managed Google Play web link', microsoftStoreForBusinessApp: 'Microsoft Store for Business app',
    windowsStoreApp: 'Microsoft Store for Business app', managedIOSStoreApp: 'Microsoft-managed iOS app', managedAndroidStoreApp: 'Microsoft-managed Android app',
    managedIOSLobApp: 'Microsoft-managed iOS app', managedAndroidLobApp: 'Microsoft-managed Android app',
  })[name] ?? (name ? `${name} app` : 'app of unknown kind');
}

/** Whether an app has its package in Intune (an app of the settings or synced kind always does). */
export function appHasPackage(payload) {
  if (appGroupOf(payload) !== 'packaged') return true;
  // Intune marks an app published once its file is uploaded and committed.
  return payload?.publishingState === 'published';
}
