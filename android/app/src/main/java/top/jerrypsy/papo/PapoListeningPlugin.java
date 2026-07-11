package top.jerrypsy.papo;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "PapoListening",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class PapoListeningPlugin extends Plugin {
    private final BroadcastReceiver eventReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            JSObject event = new JSObject();
            event.put("event", intent.getStringExtra(PapoListeningService.EXTRA_EVENT));
            event.put("batchId", intent.getStringExtra(PapoListeningService.EXTRA_BATCH_ID));
            event.put("error", intent.getStringExtra(PapoListeningService.EXTRA_ERROR));
            notifyListeners("listeningEvent", event, true);
        }
    };
    private boolean receiverRegistered;

    @Override
    public void load() {
        ContextCompat.registerReceiver(
            getContext(),
            eventReceiver,
            new IntentFilter(PapoListeningService.ACTION_EVENT),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        receiverRegistered = true;
    }

    @Override
    protected void handleOnDestroy() {
        if (receiverRegistered) {
            getContext().unregisterReceiver(eventReceiver);
            receiverRegistered = false;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        String mode = "watch".equals(call.getString("mode")) ? "watch" : "listen";
        List<String> required = new ArrayList<>();
        if (getPermissionState("microphone") != PermissionState.GRANTED) required.add("microphone");
        if ("watch".equals(mode) && getPermissionState("camera") != PermissionState.GRANTED) required.add("camera");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            required.add("notifications");
        }
        if (!required.isEmpty()) {
            requestPermissionForAliases(required.toArray(new String[0]), call, "permissionsCallback");
            return;
        }
        startWithPermissions(call);
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        String mode = "watch".equals(call.getString("mode")) ? "watch" : "listen";
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission is required");
            return;
        }
        if ("watch".equals(mode) && getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission is required for watch mode");
            return;
        }
        startWithPermissions(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), PapoListeningService.class).setAction(PapoListeningService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve(status());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void clearCredentials(PluginCall call) {
        Intent intent = new Intent(getContext(), PapoListeningService.class).setAction(PapoListeningService.ACTION_CLEAR);
        getContext().startService(intent);
        call.resolve();
    }

    private void startWithPermissions(PluginCall call) {
        if (PapoListeningService.isActive(getContext())) {
            call.reject("A background listening session is already active");
            return;
        }
        String userId = clean(call.getString("userId"));
        String apiBase = clean(call.getString("apiBase"));
        String deviceToken = clean(call.getString("deviceToken"));
        String creatureName = call.getString("creatureName", "Papo");
        String mode = "watch".equals(call.getString("mode")) ? "watch" : "listen";
        String facing = "back".equals(call.getString("cameraFacing")) ? "back" : "front";
        long durationMs = requestedDurationMs(call);
        if (userId.isEmpty()) {
            call.reject("User ID is required");
            return;
        }
        if (deviceToken.isEmpty()) {
            call.reject("Device session token is required");
            return;
        }
        if (!validApiBase(apiBase)) {
            call.reject("A secure API base URL is required");
            return;
        }
        if (durationMs < 180_000 || durationMs > 3_600_000) {
            call.reject("Listening duration is outside the supported range");
            return;
        }
        try {
            SecureListeningConfig.save(getContext(), new SecureListeningConfig.Config(userId, deviceToken, apiBase, creatureName));
        } catch (Exception error) {
            call.reject("Could not securely cache the account for background listening", error);
            return;
        }

        Intent intent = new Intent(getContext(), PapoListeningService.class)
            .setAction(PapoListeningService.ACTION_START)
            .putExtra("durationMs", durationMs)
            .putExtra("mode", mode)
            .putExtra("cameraFacing", facing);
        ContextCompat.startForegroundService(getContext(), intent);
        JSObject response = new JSObject();
        response.put("active", true);
        response.put("startedAt", System.currentTimeMillis());
        response.put("endAt", System.currentTimeMillis() + durationMs);
        response.put("mode", mode);
        response.put("cameraFacing", facing);
        call.resolve(response);
    }

    static long requestedDurationMs(PluginCall call) {
        return requestedDurationMs(call.getData().opt("durationMs"));
    }

    static long requestedDurationMs(Object value) {
        return value instanceof Number ? ((Number) value).longValue() : 180_000L;
    }

    private JSObject status() {
        JSObject status = new JSObject();
        status.put("active", PapoListeningService.isActive(getContext()));
        status.put("startedAt", PapoListeningService.sessionStartedAt(getContext()));
        status.put("endAt", PapoListeningService.sessionEndAt(getContext()));
        status.put("mode", PapoListeningService.sessionMode(getContext()));
        status.put("cameraFacing", PapoListeningService.sessionFacing(getContext()));
        status.put("pendingBatches", pendingBatchCount());
        return status;
    }

    private int pendingBatchCount() {
        java.io.File[] files = ListeningBatchUploader.queueDir(getContext()).listFiles((dir, name) -> name.endsWith(".json"));
        return files == null ? 0 : files.length;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static boolean validApiBase(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null;
        } catch (Exception error) {
            return false;
        }
    }
}
