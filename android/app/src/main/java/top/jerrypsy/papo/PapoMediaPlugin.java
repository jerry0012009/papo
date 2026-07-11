package top.jerrypsy.papo;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "PapoMedia",
    permissions = @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
)
public class PapoMediaPlugin extends Plugin {
    private final ExecutorService downloads = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void downloadMedia(PluginCall call) {
        requestStorageOrDownload(call);
    }

    @PluginMethod
    public void downloadImage(PluginCall call) {
        requestStorageOrDownload(call);
    }

    private void requestStorageOrDownload(PluginCall call) {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionCallback");
            return;
        }
        saveMedia(call);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) saveMedia(call);
        else call.reject("需要存储权限才能保存文件");
    }

    private void saveMedia(PluginCall call) {
        String url = call.getString("url", "").trim();
        String filename = safeFilename(call.getString("filename", "Papo-media"));
        String mime = call.getString("mime", "application/octet-stream");
        Uri uri = Uri.parse(url);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
            call.reject("媒体地址必须使用 HTTPS");
            return;
        }

        downloads.execute(() -> {
            try {
                String savedUri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveWithMediaStore(url, filename, mime)
                    : saveLegacy(url, filename, mime);
                JSObject result = new JSObject();
                result.put("uri", savedUri);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("保存媒体失败", error);
            }
        });
    }

    @RequiresApi(api = Build.VERSION_CODES.Q)
    private String saveWithMediaStore(String url, String filename, String mime) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Papo");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (target == null) throw new IllegalStateException("无法创建下载文件");
        try {
            try (OutputStream output = resolver.openOutputStream(target, "w")) {
                if (output == null) throw new IllegalStateException("无法打开下载文件");
                copyUrl(url, output);
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(target, ready, null, null);
            return target.toString();
        } catch (Exception error) {
            resolver.delete(target, null, null);
            throw error;
        }
    }

    @SuppressWarnings("deprecation")
    private String saveLegacy(String url, String filename, String mime) throws Exception {
        File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Papo");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建 Papo 下载目录");
        File target = uniqueFile(directory, filename);
        try (OutputStream output = new FileOutputStream(target)) {
            copyUrl(url, output);
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { target.getAbsolutePath() }, new String[] { mime }, null);
        return Uri.fromFile(target).toString();
    }

    private void copyUrl(String source, OutputStream output) throws Exception {
        HttpURLConnection connection = openConnection(source, 0);
        try {
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[32 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.flush();
            }
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection openConnection(String source, int redirects) throws Exception {
        if (redirects > 5) throw new IllegalStateException("下载重定向过多");
        URL sourceUrl = new URL(source);
        if (!"https".equalsIgnoreCase(sourceUrl.getProtocol())) throw new IllegalStateException("下载地址必须使用 HTTPS");
        HttpURLConnection connection = (HttpURLConnection) sourceUrl.openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent", "Papo-Android");
        int status = connection.getResponseCode();
        if (status >= 300 && status < 400) {
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (location == null || location.trim().isEmpty()) throw new IllegalStateException("下载重定向缺少地址");
            return openConnection(new URL(sourceUrl, location).toString(), redirects + 1);
        }
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new IllegalStateException("下载服务返回 " + status);
        }
        return connection;
    }

    private File uniqueFile(File directory, String filename) {
        File candidate = new File(directory, filename);
        if (!candidate.exists()) return candidate;
        int dot = filename.lastIndexOf('.');
        String base = dot > 0 ? filename.substring(0, dot) : filename;
        String extension = dot > 0 ? filename.substring(dot) : "";
        for (int index = 2; index < 10_000; index += 1) {
            candidate = new File(directory, base + " (" + index + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return new File(directory, System.currentTimeMillis() + "-" + filename);
    }

    private String safeFilename(String value) {
        String clean = value.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-").trim();
        return clean.isEmpty() ? "Papo-media" : clean;
    }

    @Override
    protected void handleOnDestroy() {
        downloads.shutdownNow();
    }
}
