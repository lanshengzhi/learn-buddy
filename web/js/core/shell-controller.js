/**
 * ShellController — the family-hub shell's UI state machine (map #40, slice
 * 1): the active face, nav collapse, and the layer stack. DOM-free; the DOM
 * adapter (web/next/shell.js) subscribes via onEvent and renders from state.
 *
 * The layer stack follows spec §4.2: back() peels layers in visual stacking order —
 * WordCard → Identity → Note → Toolbar → Drawer. The ordering is a
 * fixed priority, not a push order, because the layers are not freely
 * composable.
 *
 * The controller's contract is its event stream. It deliberately has no
 * reader-facing vocabulary: every face and layer change must preserve the
 * mounted reading pane (spec §4.2 #2/#3), so no event here may name or rebuild the reader.
 */

export const Layer = Object.freeze({
  WordCard: 'wordcard',
  Identity: 'identity',
  Note: 'note',
  Toolbar: 'toolbar',
  Drawer: 'drawer',
});

/** back() priority: visually topmost first (spec §4.2). */
const BACK_PRIORITY = [
  Layer.WordCard,
  Layer.Identity,
  Layer.Note,
  Layer.Toolbar,
  Layer.Drawer,
];

export const Face = Object.freeze({ Read: 'read', Chat: 'chat', Learn: 'learn' });

export class ShellController {
  /**
   * @param {object} [deps]
   * @param {boolean} [deps.narrow=false] — viewport below the ~900px breakpoint
   * @param {(event: object) => void} [deps.onEvent] — fired after every mutation
   */
  constructor({ narrow = false, onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.state = {
      narrow,
      activeFace: Face.Read,
      navCollapsed: false, // wide mode only; the narrow nav is the Drawer layer
      openLayers: [], // subset of BACK_PRIORITY, kept in priority order
    };
  }

  /** Wide: collapse/expand the nav. Narrow: open/close the drawer. */
  toggleNav() {
    if (this.state.narrow) {
      this.#setLayer(Layer.Drawer, !this.state.openLayers.includes(Layer.Drawer));
      return;
    }
    this.state = { ...this.state, navCollapsed: !this.state.navCollapsed };
    this.onEvent({ type: 'nav-toggled', collapsed: this.state.navCollapsed });
  }

  setFace(face) {
    if (face === this.state.activeFace) return;
    this.state = { ...this.state, activeFace: face };
    this.onEvent({ type: 'face-changed', face });
  }

  /**
   * Crossing the ~900px breakpoint resets the layer stack: a half-open
   * drawer or overlay has no meaningful continuation in the other layout.
   */
  setNarrow(narrow) {
    if (narrow === this.state.narrow) return;
    const hadLayers = this.state.openLayers.length > 0;
    this.state = { ...this.state, narrow, openLayers: [] };
    this.onEvent({ type: 'viewport-changed', narrow });
    if (hadLayers) this.onEvent({ type: 'layers-reset' });
  }

  open(layer) {
    this.#setLayer(layer, true);
  }

  close(layer) {
    this.#setLayer(layer, false);
  }

  /** Closes the visually topmost open layer; returns it, or null when bare. */
  back() {
    const top = BACK_PRIORITY.find((layer) => this.state.openLayers.includes(layer));
    if (top === undefined) return null;
    this.#setLayer(top, false);
    return top;
  }

  // --- internals -----------------------------------------------------------

  #setLayer(layer, present) {
    const open = new Set(this.state.openLayers);
    const changed = present ? !open.has(layer) : open.delete(layer);
    if (!changed) return;
    if (present) open.add(layer);
    const openLayers = BACK_PRIORITY.filter((l) => open.has(l));
    this.state = { ...this.state, openLayers };
    this.onEvent({ type: present ? 'layer-opened' : 'layer-closed', layer });
  }
}
