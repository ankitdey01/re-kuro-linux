#include <gtk/gtk.h>
#include <glib/gstdio.h>
#include <json-glib/json-glib.h>
#include <webkit2/webkit2.h>

#include <string.h>

typedef struct {
    GtkApplication *application;
    GtkApplicationWindow *window;
    WebKitWebView *web_view;
    gboolean demo_mode;
    gboolean signed_in;
    gboolean onboarding_completed;
    gboolean recording;
    gboolean launch_at_startup;
    gboolean launch_at_startup_registered;
    gchar *theme;
    gchar *trusted_ui_uri;
    guint64 session_generation;
} KuroState;

static gboolean env_enabled(const gchar *name) {
    const gchar *value = g_getenv(name);
    return value && (!g_ascii_strcasecmp(value, "1") || !g_ascii_strcasecmp(value, "true") ||
                     !g_ascii_strcasecmp(value, "yes"));
}

static gchar *config_path(void) {
    return g_build_filename(g_get_user_config_dir(), "kuro", "config.ini", NULL);
}

static void load_state(KuroState *state) {
    g_autofree gchar *path = config_path();
    g_autoptr(GKeyFile) key_file = g_key_file_new();
    g_autoptr(GError) error = NULL;

    state->theme = g_strdup("light");
    state->launch_at_startup = FALSE;
    state->launch_at_startup_registered = FALSE;

    if (!g_key_file_load_from_file(key_file, path, G_KEY_FILE_NONE, &error)) return;

    g_autofree gchar *theme = g_key_file_get_string(key_file, "preferences", "theme", NULL);
    if (theme && (!g_strcmp0(theme, "dark") || !g_strcmp0(theme, "light"))) {
        g_free(state->theme);
        state->theme = g_strdup(theme);
    }
    state->launch_at_startup = g_key_file_get_boolean(key_file, "preferences", "launch_at_startup", NULL);
    g_autofree gchar *autostart_path = g_build_filename(g_get_user_config_dir(), "autostart", "app.trykuro.Kuro.desktop", NULL);
    state->launch_at_startup_registered = state->launch_at_startup &&
        g_file_test(autostart_path, G_FILE_TEST_EXISTS);
}

static void save_state(const KuroState *state) {
    g_autofree gchar *dir = g_build_filename(g_get_user_config_dir(), "kuro", NULL);
    g_autofree gchar *path = config_path();
    g_autoptr(GKeyFile) key_file = g_key_file_new();
    g_autoptr(GError) error = NULL;

    if (g_mkdir_with_parents(dir, 0700) != 0) return;
    g_key_file_set_string(key_file, "preferences", "theme", state->theme ? state->theme : "light");
    g_key_file_set_boolean(key_file, "preferences", "launch_at_startup", state->launch_at_startup);

    gsize length = 0;
    g_autofree gchar *data = g_key_file_to_data(key_file, &length, &error);
    if (!data || error) return;
    g_file_set_contents(path, data, (gssize) length, NULL);
}

static void set_autostart(const KuroState *state) {
    g_autofree gchar *dir = g_build_filename(g_get_user_config_dir(), "autostart", NULL);
    g_autofree gchar *path = g_build_filename(dir, "app.trykuro.Kuro.desktop", NULL);
    if (g_mkdir_with_parents(dir, 0700) != 0) return;

    if (!state->launch_at_startup || g_getenv("FLATPAK_ID")) {
        g_remove(path);
        return;
    }

    const gchar *desktop =
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=Kuro\n"
        "Exec=kuro\n"
        "Icon=app.trykuro.Kuro\n"
        "Terminal=false\n"
        "X-GNOME-Autostart-enabled=true\n";
    g_file_set_contents(path, desktop, -1, NULL);
}

static gchar *snapshot_json(const KuroState *state) {
    const gchar *auth_state = state->signed_in ? "SignedIn" : "SignedOut";
    const gchar *recording_state = state->recording ? "Recording" : "Idle";
    gboolean controls = state->demo_mode && state->signed_in && state->onboarding_completed;
    gboolean has_config = state->demo_mode && state->signed_in;

    return g_strdup_printf(
        "{"
        "\"auth\":{\"state\":\"%s\",\"user_id\":%s,\"email\":%s,\"session_generation\":%" G_GUINT64_FORMAT "},"
        "\"recording\":{\"state\":\"%s\",\"transition\":null,\"manual_controls_allowed\":%s,\"has_active_session\":%s,\"unsupported_topology_reason\":null},"
        "\"settings\":{\"onboarding_completed\":%s,\"theme\":\"%s\",\"launch_at_startup\":%s,\"launch_at_startup_registered\":%s},"
        "\"update\":{\"required\":false,\"status\":\"up_to_date\",\"available_version\":null,\"last_error\":null},"
        "\"app\":{\"version\":\"1.1.13-linux.1\",\"platform\":\"linux\"},"
        "\"desktop_sync\":{\"has_config\":%s,\"last_error\":null},"
        "\"masking\":{\"status\":\"clear\"},"
        "\"disk\":{\"low_disk\":false}"
        "}",
        auth_state,
        state->signed_in ? "\"linux-local-user\"" : "null",
        state->signed_in ? "\"linux-user@localhost\"" : "null",
        state->session_generation,
        recording_state,
        controls ? "true" : "false",
        state->recording ? "true" : "false",
        state->onboarding_completed ? "true" : "false",
        state->theme ? state->theme : "light",
        state->launch_at_startup ? "true" : "false",
        state->launch_at_startup_registered ? "true" : "false",
        has_config ? "true" : "false");
}

static gchar *json_result_response(const gchar *id, gboolean ok, const gchar *result_json,
                                   const gchar *error_code, const gchar *error_message) {
    g_autoptr(JsonBuilder) builder = json_builder_new();
    json_builder_begin_object(builder);
    json_builder_set_member_name(builder, "type");
    json_builder_add_string_value(builder, "response");
    json_builder_set_member_name(builder, "id");
    json_builder_add_string_value(builder, id ? id : "");
    json_builder_set_member_name(builder, "ok");
    json_builder_add_boolean_value(builder, ok);

    if (ok) {
        g_autoptr(JsonParser) parser = json_parser_new();
        g_autoptr(GError) error = NULL;
        if (!result_json || !json_parser_load_from_data(parser, result_json, -1, &error))
            json_parser_load_from_data(parser, "{}", -1, NULL);
        json_builder_set_member_name(builder, "result");
        json_builder_add_value(builder, json_node_copy(json_parser_get_root(parser)));
    } else {
        json_builder_set_member_name(builder, "error");
        json_builder_begin_object(builder);
        json_builder_set_member_name(builder, "code");
        json_builder_add_string_value(builder, error_code ? error_code : "error");
        json_builder_set_member_name(builder, "message");
        json_builder_add_string_value(builder, error_message ? error_message : "The operation failed.");
        json_builder_end_object(builder);
    }
    json_builder_end_object(builder);

    g_autoptr(JsonGenerator) generator = json_generator_new();
    JsonNode *root = json_builder_get_root(builder);
    json_generator_set_root(generator, root);
    gchar *data = json_generator_to_data(generator, NULL);
    json_node_free(root);
    return data;
}

static gchar *event_snapshot(const KuroState *state) {
    g_autofree gchar *snapshot = snapshot_json(state);
    return g_strdup_printf("{\"type\":\"event\",\"event\":{\"type\":\"snapshot\",\"snapshot\":%s}}", snapshot);
}

static void send_to_page(KuroState *state, const gchar *json) {
    if (!state->web_view || !json) return;
    g_autofree gchar *script = g_strdup_printf("window.__kuroReceive(%s);", json);
    webkit_web_view_run_javascript(state->web_view, script, NULL, NULL, NULL);
}

static void send_snapshot(KuroState *state) {
    g_autofree gchar *event = event_snapshot(state);
    send_to_page(state, event);
}

static gboolean is_local_ui_uri(KuroState *state) {
    const gchar *uri = state->web_view ? webkit_web_view_get_uri(state->web_view) : NULL;
    if (!uri || !state->trusted_ui_uri) return FALSE;
    gsize trusted_length = strlen(state->trusted_ui_uri);
    return !g_strcmp0(uri, state->trusted_ui_uri) ||
        (g_str_has_prefix(uri, state->trusted_ui_uri) &&
         (uri[trusted_length] == '#' || uri[trusted_length] == '?'));
}

static gboolean on_decide_policy(WebKitWebView *web_view,
                                 WebKitPolicyDecision *decision,
                                 WebKitPolicyDecisionType decision_type,
    gpointer user_data) {
    (void) web_view;
    KuroState *state = user_data;
    if (decision_type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) return FALSE;

    WebKitNavigationPolicyDecision *navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
    WebKitURIRequest *request = webkit_navigation_policy_decision_get_request(navigation);
    const gchar *uri = webkit_uri_request_get_uri(request);
    if (uri && state->trusted_ui_uri) {
        gsize trusted_length = strlen(state->trusted_ui_uri);
        if (!g_strcmp0(uri, state->trusted_ui_uri) ||
            (g_str_has_prefix(uri, state->trusted_ui_uri) &&
             (uri[trusted_length] == '#' || uri[trusted_length] == '?'))) return FALSE;
    }

    webkit_policy_decision_ignore(decision);
    return TRUE;
}

static gboolean valid_external_uri(const gchar *uri) {
    g_autoptr(GError) error = NULL;
    GUri *parsed = g_uri_parse(uri, G_URI_FLAGS_NONE, &error);
    if (!parsed || error) return FALSE;
    const gchar *scheme = g_uri_get_scheme(parsed);
    const gchar *host = g_uri_get_host(parsed);
    gboolean valid_host = host && (!g_ascii_strcasecmp(host, "trykuro.app") ||
                                   !g_ascii_strcasecmp(host, "www.trykuro.app") ||
                                   !g_ascii_strcasecmp(host, "auth.trykuro.app"));
    gboolean valid = scheme && !g_ascii_strcasecmp(scheme, "https") && valid_host;
    g_uri_unref(parsed);
    return valid;
}

static gchar *dashboard_json(void) {
    return g_strdup(
        "{"
        "\"display_currency\":\"USD\",\"usd_to_inr_rate\":100,"
        "\"profile\":{\"email\":\"linux-user@localhost\",\"status\":\"active\",\"category_pay_enabled\":false},"
        "\"summary\":{\"recording_earned_microusd\":0,\"available_balance_microusd\":0,\"held_balance_microusd\":0,\"paid_balance_microusd\":0,\"active_duration_ms\":0,\"minimum_payout_microusd\":1000000,\"earnings_cap_microusd\":null},"
        "\"payout_methods\":[{\"method\":\"upi\",\"label\":\"UPI\",\"route\":\"manual\",\"destination_kind\":\"upi_id\"}],"
        "\"active_payout_request\":null,\"last_payout_request\":null,"
        "\"payout_message\":\"Linux services are not connected in this build.\","
        "\"category_rates_microusd_per_hour\":{}"
        "}");
}

static gchar *referral_json(void) {
    return g_strdup(
        "{\"enabled\":false,\"referral_code\":\"\",\"referrals\":[],"
        "\"referral_earnings_microusd\":0,\"effective_bonus_microusd\":0,"
        "\"effective_threshold_ms\":3600000,\"effective_cap\":null,"
        "\"pending_count\":0,\"credited_count\":0,\"signups_enabled\":false}");
}

static gchar *page_json(void) {
    return g_strdup("{\"rows\":[],\"offset\":0,\"limit\":15,\"total_count\":0}");
}

static gchar *communications_json(const KuroState *state) {
    return g_strdup_printf(
        "{\"schema_version\":1,\"revision\":\"linux-local\","
        "\"owner_user_id\":\"linux-local-user\",\"session_generation\":%" G_GUINT64_FORMAT ","
        "\"signups_enabled\":false,\"notices\":[],\"guard_notice\":null}",
        state->session_generation);
}

static gchar *handle_command(KuroState *state, const gchar *method, JsonObject *params,
                             gboolean *broadcast, const gchar **error_code,
                             const gchar **error_message) {
    *broadcast = FALSE;
    *error_code = NULL;
    *error_message = NULL;

    if (!g_strcmp0(method, "get_snapshot")) return snapshot_json(state);
    if (!g_strcmp0(method, "get_dashboard")) {
        if (!state->signed_in) {
            *error_code = "unauthorized";
            *error_message = "Sign in before loading the dashboard.";
            return NULL;
        }
        return dashboard_json();
    }
    if (!g_strcmp0(method, "get_referral") || !g_strcmp0(method, "get_communications") ||
        !g_strcmp0(method, "list_recordings") || !g_strcmp0(method, "list_ledger") ||
        !g_strcmp0(method, "get_session_segments") || !g_strcmp0(method, "present_guard_notice")) {
        if (!state->signed_in) {
            *error_code = "unauthorized";
            *error_message = "Sign in before accessing account data.";
            return NULL;
        }
        if (!g_strcmp0(method, "get_referral")) return referral_json();
        if (!g_strcmp0(method, "get_communications")) return communications_json(state);
        if (!g_strcmp0(method, "list_recordings") || !g_strcmp0(method, "list_ledger")) return page_json();
        if (!g_strcmp0(method, "get_session_segments")) return g_strdup("{}");
        return g_strdup("{\"accepted\":false}");
    }

    if (!g_strcmp0(method, "sign_in")) {
        if (!state->demo_mode) {
            *error_code = "linux_auth_unavailable";
            *error_message = "Production Kuro authentication is not connected in this Linux build.";
            return NULL;
        }
        state->signed_in = TRUE;
        state->session_generation++;
        *broadcast = TRUE;
        return snapshot_json(state);
    }
    if (!g_strcmp0(method, "cancel_sign_in")) return g_strdup("{}");
    if (!g_strcmp0(method, "sign_out")) {
        state->signed_in = FALSE;
        state->onboarding_completed = FALSE;
        state->recording = FALSE;
        state->session_generation++;
        *broadcast = TRUE;
        return snapshot_json(state);
    }
    if (!g_strcmp0(method, "complete_onboarding")) {
        if (!state->signed_in) {
            *error_code = "unauthorized";
            *error_message = "Sign in before completing onboarding.";
            return NULL;
        }
        state->onboarding_completed = TRUE;
        *broadcast = TRUE;
        return snapshot_json(state);
    }
    if (!g_strcmp0(method, "start_recording") || !g_strcmp0(method, "stop_recording")) {
        if (!state->demo_mode) {
            *error_code = "linux_capture_unavailable";
            *error_message = "The Fedora PipeWire capture backend is not connected in this build.";
            return NULL;
        }
        if (!state->signed_in || !state->onboarding_completed) {
            *error_code = "unauthorized";
            *error_message = "Complete onboarding before recording.";
            return NULL;
        }
        state->recording = !g_strcmp0(method, "start_recording");
        *broadcast = TRUE;
        return snapshot_json(state);
    }

    if (!g_strcmp0(method, "set_launch_at_startup")) {
        if (g_getenv("FLATPAK_ID")) {
            *error_code = "linux_autostart_unavailable";
            *error_message = "Launch at startup is managed by the Fedora or Flatpak package environment.";
            return NULL;
        }
        gboolean enabled = params && json_object_has_member(params, "enabled")
            ? json_object_get_boolean_member(params, "enabled") : FALSE;
        state->launch_at_startup = enabled;
        save_state(state);
        set_autostart(state);
        state->launch_at_startup_registered = state->launch_at_startup && !g_getenv("FLATPAK_ID");
        *broadcast = TRUE;
        return snapshot_json(state);
    }
    if (!g_strcmp0(method, "set_theme")) {
        const gchar *theme = params && json_object_has_member(params, "theme")
            ? json_object_get_string_member(params, "theme") : "light";
        if (g_strcmp0(theme, "dark") && g_strcmp0(theme, "light")) {
            *error_code = "invalid_theme";
            *error_message = "The requested theme is not available.";
            return NULL;
        }
        g_free(state->theme);
        state->theme = g_strdup(theme);
        save_state(state);
        return g_strdup("{}");
    }
    if (!g_strcmp0(method, "resize_window")) {
        const gchar *mode = params && json_object_has_member(params, "mode")
            ? json_object_get_string_member(params, "mode") : "dashboard";
        gint width = !g_strcmp0(mode, "solo") ? 600 : 800;
        gint height = !g_strcmp0(mode, "solo") ? 400 : 600;
        gtk_window_set_default_size(GTK_WINDOW(state->window), width, height);
        return g_strdup("{}");
    }
    if (!g_strcmp0(method, "hide_window")) {
        gtk_widget_set_visible(GTK_WIDGET(state->window), FALSE);
        return g_strdup("{}");
    }
    if (!g_strcmp0(method, "begin_window_drag")) return g_strdup("{}");
    if (!g_strcmp0(method, "quit")) {
        g_application_quit(G_APPLICATION(state->application));
        return g_strdup("{}");
    }
    if (!g_strcmp0(method, "check_updates")) {
        *broadcast = TRUE;
        return snapshot_json(state);
    }
    if (!g_strcmp0(method, "install_update")) {
        *error_code = "linux_updates_unavailable";
        *error_message = "Linux updates are managed by the Fedora or Flatpak package source.";
        return NULL;
    }
    if (!g_strcmp0(method, "open_external_url")) {
        const gchar *uri = params && json_object_has_member(params, "url")
            ? json_object_get_string_member(params, "url") : NULL;
        if (!uri || !valid_external_uri(uri)) {
            *error_code = "invalid_url";
            *error_message = "Only HTTPS links can be opened.";
            return NULL;
        }
        g_autoptr(GError) error = NULL;
        if (!g_app_info_launch_default_for_uri(uri, NULL, &error)) {
            *error_code = "open_url_failed";
            *error_message = "The link could not be opened in the default browser.";
            return NULL;
        }
        return g_strdup("{}");
    }
    if (!g_strcmp0(method, "request_payout")) {
        *error_code = "linux_payout_unavailable";
        *error_message = "Production payout services are not connected in this Linux build.";
        return NULL;
    }

    *error_code = "unsupported_method";
    *error_message = "The requested operation is not available in this Linux host.";
    return NULL;
}

static void on_script_message(WebKitUserContentManager *manager,
                              WebKitJavascriptResult *javascript_result,
                              gpointer user_data) {
    (void) manager;
    KuroState *state = user_data;
    if (!is_local_ui_uri(state)) return;
    JSCValue *value = webkit_javascript_result_get_js_value(javascript_result);
    g_autofree gchar *message = jsc_value_to_string(value);
    if (!message || strlen(message) > 65536) return;

    g_autoptr(JsonParser) parser = json_parser_new();
    g_autoptr(GError) parse_error = NULL;
    if (!json_parser_load_from_data(parser, message, -1, &parse_error)) return;
    JsonNode *root = json_parser_get_root(parser);
    if (!JSON_NODE_HOLDS_OBJECT(root)) return;
    JsonObject *request = json_node_get_object(root);
    if (!json_object_has_member(request, "id") || !json_object_has_member(request, "method")) return;

    const gchar *id = json_object_get_string_member(request, "id");
    const gchar *method = json_object_get_string_member(request, "method");
    JsonObject *params = NULL;
    if (json_object_has_member(request, "params")) {
        JsonNode *params_node = json_object_get_member(request, "params");
        if (params_node && JSON_NODE_HOLDS_OBJECT(params_node)) params = json_node_get_object(params_node);
    }

    gboolean broadcast = FALSE;
    const gchar *error_code = NULL;
    const gchar *error_message = NULL;
    g_autofree gchar *result = handle_command(state, method, params, &broadcast, &error_code, &error_message);
    g_autofree gchar *response = json_result_response(id, result != NULL, result, error_code, error_message);
    send_to_page(state, response);
    if (broadcast) send_snapshot(state);
}

static void on_activate(GtkApplication *application, gpointer user_data) {
    KuroState *state = user_data;
    if (state->window) {
        gtk_widget_set_visible(GTK_WIDGET(state->window), TRUE);
        gtk_window_present(state->window);
        return;
    }

    state->window = GTK_APPLICATION_WINDOW(gtk_application_window_new(application));
    gtk_window_set_title(GTK_WINDOW(state->window), "Kuro");
    gtk_window_set_default_size(GTK_WINDOW(state->window), 600, 400);
    gtk_window_set_resizable(GTK_WINDOW(state->window), FALSE);

    WebKitUserContentManager *content_manager = webkit_user_content_manager_new();
    g_signal_connect(content_manager, "script-message-received::kuro",
                     G_CALLBACK(on_script_message), state);
    webkit_user_content_manager_register_script_message_handler(content_manager, "kuro");

    state->web_view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_user_content_manager(content_manager));
    g_signal_connect(state->web_view, "decide-policy", G_CALLBACK(on_decide_policy), state);
    gtk_container_add(GTK_CONTAINER(state->window), GTK_WIDGET(state->web_view));

    g_autofree gchar *ui_path = g_build_filename(PACKAGE_DATADIR, "kuro", "ui", "index.html", NULL);
    if (!g_file_test(ui_path, G_FILE_TEST_EXISTS)) {
        g_free(ui_path);
        ui_path = g_build_filename(PROJECT_UI_DIR, "index.html", NULL);
    }
    g_autofree gchar *uri = g_filename_to_uri(ui_path, NULL, NULL);
    if (uri) {
        state->trusted_ui_uri = g_strdup(uri);
        webkit_web_view_load_uri(state->web_view, uri);
    }

    gtk_widget_show_all(GTK_WIDGET(state->window));
    gtk_window_present(state->window);
}

static void on_shutdown(GApplication *application, gpointer user_data) {
    (void) application;
    KuroState *state = user_data;
    save_state(state);
    g_clear_pointer(&state->theme, g_free);
    g_clear_pointer(&state->trusted_ui_uri, g_free);
    g_free(state);
}

int main(int argc, char **argv) {
    KuroState *state = g_new0(KuroState, 1);
    state->demo_mode = env_enabled("KURO_LINUX_DEMO");
    load_state(state);

    GtkApplication *application = gtk_application_new(
        "app.trykuro.Kuro", G_APPLICATION_DEFAULT_FLAGS);
    state->application = application;
    g_signal_connect(application, "activate", G_CALLBACK(on_activate), state);
    g_signal_connect(application, "shutdown", G_CALLBACK(on_shutdown), state);

    int status = g_application_run(G_APPLICATION(application), argc, argv);
    g_object_unref(application);
    return status;
}
