import policy from "./release-policy.cjs";
const platforms = {
  mac: {
    os: "macos-latest",
    command: "npm run package:mac",
    certificate: "MAC_CSC_LINK",
    certificatePassword: "MAC_CSC_KEY_PASSWORD",
  },
  win: {
    os: "windows-latest",
    command: "npm run package:win",
    certificate: "WIN_CSC_LINK",
    certificatePassword: "WIN_CSC_KEY_PASSWORD",
  },
};
console.log(
  JSON.stringify({
    include: Object.keys(policy.getReleasePolicy()).map(
      (platform) => platforms[platform],
    ),
  }),
);
