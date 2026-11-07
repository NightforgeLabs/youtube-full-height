const automatic = document.getElementById("automatic");
chrome.storage.local.get("automatic").then(settings => {automatic.checked = settings.automatic ?? true;});
automatic.onchange = () => chrome.storage.local.set({automatic: automatic.checked});
async function open(view) {
  try {
    const reply = await chrome.runtime.sendMessage({type: "openCurrent", view});
    if (reply?.ok) window.close();
    else document.getElementById("status").textContent = reply?.error || "Could not pop out this video.";
  } catch (error) {document.getElementById("status").textContent = error.message;}
}
document.getElementById("open").onclick = () => open("full");
