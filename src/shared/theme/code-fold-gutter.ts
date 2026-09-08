import { foldGutter } from "@codemirror/language";

export const purrFoldGutter = foldGutter({
  markerDOM(open) {
    const marker = document.createElement("span");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    marker.className = "ui-code-fold";
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    path.setAttribute("points", open ? "6 9 12 15 18 9" : "9 18 15 12 9 6");
    icon.append(path);
    marker.append(icon);
    marker.setAttribute("aria-hidden", "true");
    return marker;
  },
});
