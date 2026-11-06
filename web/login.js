// Sign-in page: shows the Google button (and, on localhost with DEV_LOGIN=1, one button per allowed user).
const params = new URLSearchParams(location.search);
const error = params.get("error");
if (error) {
  const el = document.getElementById("error");
  el.textContent = error;
  el.hidden = false;
}

const opts = await fetch("/auth/options").then((r) => r.json()).catch(() => ({ google: true, dev: [] }));
document.getElementById("google").hidden = !opts.google;
if (opts.dev?.length) {
  const box = document.getElementById("dev-users");
  for (const email of opts.dev) {
    const b = document.createElement("button");
    b.type = "submit";
    b.name = "email";
    b.value = email;
    b.className = "dev-btn";
    b.textContent = email;
    box.append(b);
  }
  document.getElementById("dev").hidden = false;
}
