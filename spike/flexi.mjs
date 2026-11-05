// Minimal Flexischools HTTP client for spikes (no browser). Never logs tokens.
const COGNITO_CLIENT_ID = "1g1a80gfo3ovuq75c8fqjrg3ma"; // public app-client id
const COGNITO_URL = "https://cognito-idp.ap-southeast-2.amazonaws.com/";
export const ORDERING = "https://bffordering.flexischools.com.au";
const APP = { "x-channel": "USERPORTAL", "x-brandid": "8", "content-type": "application/json" };

async function cognito(target, body) {
  const r = await fetch(COGNITO_URL, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: COGNITO_CLIENT_ID, ...body }),
  });
  return r.json();
}

export async function login() {
  const { FLEXISCHOOL_USERNAME: u, FLEXISCHOOL_PASSWORD: p } = process.env;
  const j = await cognito("InitiateAuth", { AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: u, PASSWORD: p } });
  if (!j.AuthenticationResult) throw new Error("login failed: " + (j.__type ?? j.ChallengeName));
  const token = j.AuthenticationResult.IdToken;
  const api = async (method, path, body) => {
    const r = await fetch(path.startsWith("http") ? path : ORDERING + path, {
      method, headers: { ...APP, authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  return { api };
}
