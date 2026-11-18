import { emit } from "@tauri-apps/api/event";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok, message) => { if (!ok) throw new Error(message); };
const card = () => document.querySelector('.notch-stack-card[data-slot="active"]');
async function showWeather() {
  await wait(100);
  if (document.querySelector("[data-notch]").getAttribute("aria-expanded") !== "true") { await emit("notch-press", null); await wait(700); }
  for (let i=0; i<7 && card()?.dataset.widget !== "weather"; i++) {
    document.querySelector(".notch-stack").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); await wait(150);
  }
  await wait(500);
}
window.runWeatherScenario = async scenario => {
  if (scenario === "disabled") { await wait(200); check(!window.__notchCommands.some(c => c.command === "weather_get"), "disabled weather makes no requests"); return { scenario, ok:true }; }
  if (scenario === "settings") {
    const input = document.querySelector("#weather-city");
    const setInput = text => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,text); input.dispatchEvent(new Event("input",{bubbles:true})); };
    setInput("xx"); await wait(30); document.querySelector(".config-weather form").requestSubmit(); await wait(100);
    check(document.querySelector(".config-weather").textContent.includes("Kota tidak ditemukan"), "empty search has an actionable message");
    setInput("Kota"); await wait(30); document.querySelector(".config-weather form").requestSubmit(); await wait(100);
    document.querySelector(".config-weather-results button").click(); await wait(50);
    document.querySelector(".config-save").click(); await wait(50);
    check(window.__savedConfig.weatherLocation.name.includes("Kota uji") && !window.__savedConfig.weatherFollowWindows, "manual city and mode persist in config payload");
    return { scenario, ok:true };
  }
  if (scenario === "windows-settings") {
    window.__windowsDenied = true;
    document.querySelector(".config-weather-windows").click(); await wait(80);
    check(document.querySelector(".config-weather [role=alert]").textContent.includes("ditolak"), "Windows access denial is explained");
    window.__windowsDenied = false;
    document.querySelector(".config-weather-windows").click(); await wait(80);
    document.querySelector(".config-save").click(); await wait(50);
    check(window.__savedConfig.weatherFollowWindows && window.__savedConfig.weatherLocation.name === "Lokasi Windows", "Windows location and follow mode persist");
    return { scenario, ok:true };
  }
  await showWeather();
  if (scenario === "unset") {
    check(card().textContent.includes("Pilih lokasi") && !card().querySelector(".notch-weather-temp"), "no configured location never invents weather");
    card().querySelector("button").click(); await wait(50);
    check(window.__notchCommands.some(c => c.command === "config_open"), "setup opens native settings");
    check(!window.__notchCommands.some(c => c.command === "weather_get"), "unset location makes no weather requests");
  } else if (scenario === "error") {
    check(card().textContent.includes("Cuaca belum tersedia") && !card().querySelector(".notch-weather-temp"), "failure has no fake temperature");
    window.__weatherFail = false;
    [...card().querySelectorAll("button")].find(b => b.textContent === "Coba lagi").click(); await wait(250);
    check(card().querySelector(".notch-weather-temp [aria-hidden]")?.textContent === "26°", "retry recovers with provider data");
  } else {
    check(card().querySelector(".notch-weather-temp [aria-hidden]")?.textContent === "26°", "current temperature comes from the response");
    check(card().querySelector(".notch-weather-condition")?.textContent === "Hujan", "WMO condition is translated");
    check(card().querySelectorAll(".notch-weather-hour").length === 4, "four future hours are visible");
    check(card().querySelector(".notch-weather-detail").getBoundingClientRect().bottom <= card().querySelector(".notch-weather-hours").getBoundingClientRect().top, "condition and data timestamp do not overlap hourly forecast");
    if (scenario === "stale") check(card().textContent.includes("Data lama"), "old provider measurements are labelled stale");
    if (scenario === "refresh-failure") {
      const clock = Date.now;
      let offset = 16 * 60_000;
      Date.now = () => clock() + offset;
      window.__weatherFail = true;
      window.dispatchEvent(new Event("focus")); await wait(200);
      check(card().textContent.includes("Data lama") && card().querySelector(".notch-weather-temp [aria-hidden]")?.textContent === "26°", "failed refresh retains the last reading with a stale label");
      window.__weatherFail = false; offset += 16 * 60_000;
      window.dispatchEvent(new Event("focus")); await wait(200);
      check(!card().textContent.includes("Data lama"), "later successful refresh clears the stale label");
      Date.now = clock;
      return {scenario,ok:true};
    }
    card().querySelector(".notch-weather-source").click(); await wait(30);
    check(window.__notchCommands.some(c => c.command === "weather_open_source"), "source attribution opens the provider");
    const before = window.__notchCommands.filter(c => c.command === "weather_get").length;
    card().dispatchEvent(new MouseEvent("contextmenu", {bubbles:true,cancelable:true})); await wait(100);
    document.querySelector(".notch-menu-item").click(); await wait(700);
    check(document.querySelector('.notch-pin-card[data-widget="weather"] .notch-pin-weather-temp')?.textContent === "26°", "pin shares current weather");
    check(window.__notchCommands.filter(c => c.command === "weather_get").length === before && before === 1, "pin and StrictMode do not duplicate the fetch");
  }
  const root = document.querySelector(".notch-nook").getBoundingClientRect();
  for (const node of document.querySelectorAll('.notch-stack-card[data-slot="active"] button,.notch-stack-card[data-slot="active"] .notch-weather-hours')) {
    const box=node.getBoundingClientRect(); check(box.bottom<=root.bottom+1 && box.right<=root.right+1,"weather controls fit the Nook slot");
  }
  return {scenario,ok:true};
};
