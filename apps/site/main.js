// Progressive enhancement only: the page works with links alone.
const root = document.documentElement;

for (const button of document.querySelectorAll("[data-set-mode]")) {
  button.setAttribute("aria-pressed", String(root.dataset.mode === button.dataset.setMode));
  button.addEventListener("click", () => {
    root.dataset.mode = button.dataset.setMode;
    localStorage.setItem("localbox-mode", button.dataset.setMode);
    for (const other of document.querySelectorAll("[data-set-mode]"))
      other.setAttribute("aria-pressed", String(other === button));
    window.scrollTo({ top: 0 });
  });
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    const done = button.querySelector(".copy-done");
    try {
      await navigator.clipboard.writeText(source.textContent);
      done.textContent = "✓ copied";
    } catch {
      getSelection().selectAllChildren(source);
      done.textContent = "selected, press ⌘C";
    }
    setTimeout(() => (done.textContent = ""), 2400);
  });
}

// The header gains a rule once the page scrolls under it.
const bar = document.querySelector(".bar");
const onScroll = () => bar.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// The blobs watch the cursor.
const eyes = [...document.querySelectorAll(".blob .eyes")];
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  addEventListener("pointermove", (event) => {
    for (const group of eyes) {
      const box = group.ownerSVGElement.getBoundingClientRect();
      if (!box.width) continue;
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const length = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, length / 300) * 4;
      for (const eye of group.children)
        eye.style.transform = `translate(${(dx / length) * reach}px, ${(dy / length) * reach}px)`;
    }
  });
}
