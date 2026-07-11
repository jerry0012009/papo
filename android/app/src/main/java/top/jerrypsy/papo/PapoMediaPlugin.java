package top.jerrypsy.papo;

import android.app.DownloadManager;
import android.Manifest;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "PapoMedia",
    permissions = @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
)
public class PapoMediaPlugin extends Plugin {
    @PluginMethod
    public void downloadImage(PluginCall call) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionCallback");
            return;
        }
        enqueueDownload(call);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) enqueueDownload(call);
        else call.reject("Storage permission is required to save the image");
    }

    private void enqueueDownload(PluginCall call) {
        String url = call.getString("url", "").trim();
        String filename = safeFilename(call.getString("filename", "Papo-image.jpg"));
        String mime = call.getString("mime", "image/jpeg");
        Uri uri = Uri.parse(url);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            call.reject("The image URL must use HTTPS");
            return;
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle(filename)
                .setDescription("正在保存 Papo 图片")
                .setMimeType(mime)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            long id = manager.enqueue(request);
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to download image", error);
        }
    }

    private String safeFilename(String value) {
        String clean = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-").trim();
        return clean.isEmpty() ? "Papo-image.jpg" : clean;
    }
}
