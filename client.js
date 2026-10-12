// Client half of dsh-session-delete.
//
// Adds a "删除会话" (Delete Session) row to each Session's "..." menu in the
// sidebar. Confirming calls the Host route that permanently removes the Session
// log; the Host also detaches the live Session, so `session/disposed` ->
// `api-session/removed` removes the sidebar row without a reload.
//
// The `id` below must be exactly the `name` field of the sibling package.json.
// client-modules derives the browser bundle's id from the resolved package's
// name and then rejects a bundle that registers under anything else
// ("loaded without registering ... via __ModuleLoader__.load"), which shows up
// only as a missing menu row. Renaming the package means renaming this string.
window.__ModuleLoader__.load({
  id: "dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** Locale namespace for this plugin's copy. */
    const NS = "session-delete";

    const zh = {
      "menu.deleteSession": "删除会话",
      "menu.deleting": "正在删除",
      "confirm.title": "删除会话",
      "confirm.body": "此操作将永久删除该会话记录，无法撤销。",
      "toast.failed": "删除会话失败：{reason}",
    };

    const en = {
      "menu.deleteSession": "Delete Session",
      "menu.deleting": "Deleting",
      "confirm.title": "Delete Session",
      "confirm.body": "This permanently deletes the session record and cannot be undone.",
      "toast.failed": "Could not delete session: {reason}",
    };

    /** Host route that performs the deletion. Stable across Host generations. */
    const ROUTE = "/plugins/session-delete/delete";

    /**
     * Ask the Host to delete one Session.
     * @param sessionId - Session to delete.
     * @returns the Host report.
     */
    async function requestDelete(sessionId) {
      const response = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    /**
     * One "..." menu row that deletes the Session it was rendered for.
     *
     * `sessionId`/`displayTitle` arrive as owner props, `t` from the entry's
     * locale namespace, and `useMenuOpenState` from the slot declaration's
     * injected hooks.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const [busy, setBusy] = react.useState(false);

      const onSelect = react.useCallback(() => {
        setMenuOpen(false);
        const title = displayTitle || sessionId;
        if (!window.confirm(`${t("confirm.title")}\n\n${title}\n${t("confirm.body")}`)) return;
        setBusy(true);
        requestDelete(sessionId)
          .catch((error) => {
            window.alert(
              t("toast.failed", { reason: error instanceof Error ? error.message : String(error) })
            );
          })
          .finally(() => {
            setBusy(false);
          });
      }, [displayTitle, sessionId, setMenuOpen, t]);

      return react_jsx_runtime.jsx(primitives.MenuItemButton, {
        danger: true,
        disabled: busy,
        icon: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
        onSelect,
        children: busy ? t("menu.deleting") : t("menu.deleteSession"),
      });
    }

    /** Stable browser-plugin name. */
    const name = "session-delete-client";

    /** Client services this bundle needs. */
    const inject = ["slots", "locale"];

    /**
     * Register this plugin's copy and its Session-menu row.
     *
     * The whole body is guarded so a slot-API change degrades to a console
     * error instead of failing the whole plugin graph.
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: copy");
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "session-delete",
              order: 500,
              locale: NS,
            },
            DeleteSessionMenuItem
          )
        );
      } catch (error) {
        console.error("session-delete: client registration failed", error);
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});