// App-level settings that a fork changes in code (not secrets, not per deployment).
// Renaming the app? Change `name` here and in public/manifest.webmanifest.

export const APP = {
  // Placeholders: replace with your app's name (also in public/manifest.webmanifest).
  name: "Your App Name",
  shortName: "Your App",
  description: "Your training, at a glance. Built on SweatStack.",

  // What we ask the athlete for on SweatStack's consent screen. Ask for as little as possible:
  // every category adds a line to the consent screen. Categories: https://docs.sweatstack.no/learn/authentication/scopes/
  // When you add one, also tick it (with a purpose) on your app's Consent screen tab in SweatStack.
  scopes: ["openid", "profile", "activities:read", "offline_access"],

  // Under "Sign in with SweatStack": name the accounts your users already have (SweatStack's brand guidance).
  signInSubtitle: "Use your Intervals.icu or Wahoo account",

  // Activities per page on /activities.
  pageSize: 20,

  // Weeks shown in the dashboard trend chart.
  trendWeeks: 12,
} as const;
