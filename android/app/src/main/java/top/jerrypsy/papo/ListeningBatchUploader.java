package top.jerrypsy.papo;

import android.content.Context;
import android.util.Base64;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONObject;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLEncoder;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

final class ListeningBatchUploader {
    private static final String WORK_NAME = "papo-listening-upload";
    private static final long MEDIA_RETENTION_MS = 24L * 60L * 60L * 1000L;
    private static final Object UPLOAD_LOCK = new Object();

    private ListeningBatchUploader() {}

    static File queueDir(Context context) {
        File dir = new File(context.getFilesDir(), "listening-queue");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    static File createMediaFile(Context context, String batchId, String suffix) {
        return new File(queueDir(context), safeBatchId(batchId) + suffix);
    }

    static void enqueue(
        Context context,
        String batchId,
        String observedAt,
        String cameraFacing,
        File audioFile,
        File imageFile
    ) throws Exception {
        JSONObject metadata = new JSONObject();
        metadata.put("batchId", batchId);
        metadata.put("observedAt", observedAt);
        metadata.put("cameraFacing", cameraFacing == null ? "" : cameraFacing);
        metadata.put("audioFile", audioFile != null && audioFile.exists() ? audioFile.getName() : "");
        metadata.put("imageFile", imageFile != null && imageFile.exists() ? imageFile.getName() : "");
        File metadataFile = new File(queueDir(context), safeBatchId(batchId) + ".json");
        writeAtomically(metadataFile, metadata.toString().getBytes(StandardCharsets.UTF_8));
        schedule(context);
    }

    static boolean uploadAll(Context context) {
        synchronized (UPLOAD_LOCK) {
            SecureListeningConfig.Config config;
            try {
                config = SecureListeningConfig.load(context);
            } catch (Exception error) {
                return false;
            }
            if (config == null) return false;

            File[] batches = queueDir(context).listFiles((dir, name) -> name.endsWith(".json"));
            if (batches == null || batches.length == 0) return true;
            Arrays.sort(batches, Comparator.comparing(File::getName));
            for (File batch : batches) {
                try {
                    if (System.currentTimeMillis() - batch.lastModified() >= MEDIA_RETENTION_MS) {
                        deleteBatchFiles(context, batch);
                        continue;
                    }
                    if (!uploadOne(context, config, batch)) return false;
                } catch (Exception error) {
                    return false;
                }
            }
            return true;
        }
    }

    static boolean hasPending(Context context) {
        File[] batches = queueDir(context).listFiles((dir, name) -> name.endsWith(".json"));
        return batches != null && batches.length > 0;
    }

    static void clearQueue(Context context) {
        File[] files = queueDir(context).listFiles();
        if (files == null) return;
        for (File file : files) file.delete();
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
    }

    static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(ListeningUploadWorker.class)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request);
    }

    private static boolean uploadOne(Context context, SecureListeningConfig.Config config, File metadataFile) throws Exception {
        JSONObject metadata = new JSONObject(new String(readFile(metadataFile), StandardCharsets.UTF_8));
        File audioFile = fileFromMetadata(context, metadata.optString("audioFile"));
        File imageFile = fileFromMetadata(context, metadata.optString("imageFile"));
        if (audioFile == null && imageFile == null) {
            metadataFile.delete();
            return true;
        }

        JSONObject body = new JSONObject();
        body.put("batchId", metadata.getString("batchId"));
        body.put("observedAt", metadata.getString("observedAt"));
        String facing = metadata.optString("cameraFacing");
        if (!facing.isEmpty()) body.put("cameraFacing", facing);
        if (audioFile != null) body.put("audioDataUrl", "data:audio/mp4;base64," + encodeFile(audioFile));
        if (imageFile != null) body.put("imageDataUrl", "data:image/jpeg;base64," + encodeFile(imageFile));

        String apiBase = config.apiBase.replaceAll("/+$", "");
        String userId = URLEncoder.encode(config.userId, "UTF-8");
        URL url = new URL(apiBase + "/profiles/" + userId + "/listening/native-batch");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(180_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "Papo-Android/1");
        if (config.deviceToken != null && !config.deviceToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + config.deviceToken);
        }
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload);
            output.flush();
        }
        int status = connection.getResponseCode();
        connection.disconnect();
        if (status < 200 || status >= 300) return false;

        metadataFile.delete();
        if (audioFile != null) audioFile.delete();
        if (imageFile != null) imageFile.delete();
        PapoListeningService.broadcast(context, "batch-uploaded", metadata.getString("batchId"), null);
        return true;
    }

    private static File fileFromMetadata(Context context, String name) {
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("\\")) return null;
        File file = new File(queueDir(context), name);
        return file.exists() && file.length() > 0 ? file : null;
    }

    private static void deleteBatchFiles(Context context, File metadataFile) {
        try {
            JSONObject metadata = new JSONObject(new String(readFile(metadataFile), StandardCharsets.UTF_8));
            File audioFile = fileFromMetadata(context, metadata.optString("audioFile"));
            File imageFile = fileFromMetadata(context, metadata.optString("imageFile"));
            if (audioFile != null) audioFile.delete();
            if (imageFile != null) imageFile.delete();
        } catch (Exception ignored) {
            // Invalid metadata cannot be uploaded safely; remove its marker below.
        }
        metadataFile.delete();
    }

    private static String encodeFile(File file) throws Exception {
        return Base64.encodeToString(readFile(file), Base64.NO_WRAP);
    }

    private static byte[] readFile(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toByteArray();
        }
    }

    private static void writeAtomically(File target, byte[] data) throws Exception {
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(data);
            output.getFD().sync();
        }
        if (!temporary.renameTo(target)) throw new IllegalStateException("Could not persist listening batch");
    }

    private static String safeBatchId(String batchId) {
        return batchId.replaceAll("[^a-zA-Z0-9._-]", "_");
    }
}
