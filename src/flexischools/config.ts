// Constants discovered from the Flexischools web app (see ARCHITECTURE.md, "Flexischools integration").

export const COGNITO_URL = "https://cognito-idp.ap-southeast-2.amazonaws.com/";
/** Public app-client id of the Flexischools Cognito user pool (appears in the site's own cookie names). Not a secret. */
export const COGNITO_CLIENT_ID = "1g1a80gfo3ovuq75c8fqjrg3ma";
export const ORDERING_BASE_URL = "https://bffordering.flexischools.com.au";
export const SERVICE_BFF_BASE_URL = "https://servicebff.flexischools.com.au";

/** All cutoffs and fulfilment times are local to the school (Sydney). */
export const DEFAULT_TIMEZONE = "Australia/Sydney";

/** `x-channel` the *user portal* sends (reads, cancel). */
export const CHANNEL_USER_PORTAL = "USERPORTAL";
/** `x-channel` the *ordering app* sends when placing orders. */
export const CHANNEL_ORDERING_PORTAL = "ORDERINGPORTAL";
export const BRAND_ID = "8";
