// Read existing deployment variables in memory; report presence, never secret values.
const endpoint = "https://backboard.railway.com/graphql/v2";
const projectId = process.env.RAILWAY_PROJECT_ID;
const environmentId = "ec92103f-adb3-4971-98c8-3293ca9f5409";
if (projectId !== "8f89e295-3661-47a7-aee7-b4b26b2f5b06") throw new Error("Expected the existing staging project");
for (const [name, serviceId] of [["api", "b43a1be8-b13c-4398-8b1e-e37a99d7da72"], ["identity", "ace63816-4094-48e5-b9ff-45d7dfa44d06"], ["web", "78e3189c-8a18-406d-9c64-f5f8ceb7db53"]]) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` },
    body: JSON.stringify({ query: "query($projectId:String!,$environmentId:String!,$serviceId:String){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}", variables: { projectId, environmentId, serviceId } }),
  });
  const result = await response.json();
  if (!response.ok || result.errors) throw new Error(`Unable to inspect ${name} settings`);
  const vars = result.data.variables;
  console.log(JSON.stringify({ service: name, APP_MODE: vars.APP_MODE ?? null, APP_ENV: vars.APP_ENV ?? null, MAIL_MODE: vars.MAIL_MODE ?? null, MAIL_PUBLIC_ENABLED: vars.MAIL_PUBLIC_ENABLED ?? null, AUTH_GOOGLE_ENABLED: vars.AUTH_GOOGLE_ENABLED ?? null, APP_ORIGIN: vars.APP_ORIGIN ?? null, API_INTERNAL_URL: vars.API_INTERNAL_URL ?? null, AUTH_DATABASE_NAME: vars.AUTH_DATABASE_NAME ?? null, databaseConfigured: Boolean(vars.DATABASE_URL), resendConfigured: Boolean(vars.RESEND_API_KEY), mailFromConfigured: Boolean(vars.MAIL_FROM), hmacConfigured: Boolean(vars.EMAIL_CHALLENGE_HMAC_KEY), googleConfigured: Boolean(vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET && vars.GOOGLE_REDIRECT_URI), acceptanceTokenConfigured: Boolean(vars.ACCEPTANCE_TEST_TOKEN) }));
}
