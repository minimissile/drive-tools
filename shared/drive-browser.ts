export interface DriveBrowserBinding {
  environmentId: string;
  profileId: string;
  profileName: string;
  connectorKey: string;
  signature: string;
  uid: string;
  nickname: string;
  exitIp: string;
  requireProxy: boolean;
  boundAt: string;
}
export interface DriveBrowserPreview {
  token: string;
  accountId: string;
  profileId: string;
  profileName: string;
  uid: string;
  nickname: string;
  exitIp: string;
  requireProxy: boolean;
  headless: boolean;
}
export type NewDriveBrowserPreview = Omit<DriveBrowserPreview, "accountId">;
export type DriveAccountBrowserInput =
  { engine: "electron" } | { engine: "bitbrowser"; previewToken: string };
export interface DriveBrowserContract {
  "driveBrowser.previewNew": {
    args: { profileId: string; connectorKey: string; requireProxy: boolean };
    value: NewDriveBrowserPreview;
  };
  "driveBrowser.preview": {
    args: {
      accountId: string;
      profileId: string;
      connectorKey: string;
      requireProxy: boolean;
    };
    value: DriveBrowserPreview;
  };
  "driveBrowser.bind": { args: { token: string }; value: DriveBrowserPreview };
  "driveBrowser.unbind": {
    args: { accountId: string };
    value: { backgroundStopped: boolean };
  };
  "driveBrowser.background": {
    args: { accountId: string; confirmed: true };
    value: { headless: true };
  };
}
