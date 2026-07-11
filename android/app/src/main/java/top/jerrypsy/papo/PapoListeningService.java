package top.jerrypsy.papo;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PapoListeningService extends Service {
    static final String ACTION_EVENT = "top.jerrypsy.papo.LISTENING_EVENT";
    static final String ACTION_START = "top.jerrypsy.papo.action.START_LISTENING";
    static final String ACTION_STOP = "top.jerrypsy.papo.action.STOP_LISTENING";
    static final String ACTION_CLEAR = "top.jerrypsy.papo.action.CLEAR_LISTENING";
    static final String EXTRA_EVENT = "event";
    static final String EXTRA_BATCH_ID = "batchId";
    static final String EXTRA_ERROR = "error";
    static final long SLICE_MS = 2 * 60_000;
    static final long CAMERA_INTERVAL_MS = 5 * 60_000;
    static final long CAMERA_RETRY_MS = 15_000;
    private static final int NOTIFICATION_ID = 2401;
    private static final String CHANNEL_ID = "papo_listening";
    private static final String SESSION_ACTIVE = "session_active";
    private static final String SESSION_STARTED_AT = "session_started_at";
    private static final String SESSION_END_AT = "session_end_at";
    private static final String SESSION_MODE = "session_mode";
    private static final String SESSION_FACING = "session_facing";
    private static final String SESSION_LAST_CAMERA_CAPTURE_AT = "session_last_camera_capture_at";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();
    private MediaRecorder recorder;
    private File recordingFile;
    private CameraFrameCapture camera;
    private PowerManager.WakeLock wakeLock;
    private long startedAt;
    private long endAt;
    private int batchIndex;
    private String mode = "listen";
    private String cameraFacing = "front";
    private long lastCameraCaptureAt;
    private int cameraIndex;
    private boolean cameraReady;
    private boolean stopping;
    private boolean discarding;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSession("stopped");
            return START_NOT_STICKY;
        }
        if (ACTION_CLEAR.equals(action)) {
            clearSessionData();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            startSessionFromIntent(intent);
            return START_STICKY;
        }
        if (restoreSession()) return START_STICKY;
        stopSelf();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        releaseRecorder(false);
        if (camera != null) camera.close();
        camera = null;
        releaseWakeLock();
        uploadExecutor.shutdown();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    static void broadcast(Context context, String event, String batchId, String error) {
        Intent intent = new Intent(ACTION_EVENT).setPackage(context.getPackageName());
        intent.putExtra(EXTRA_EVENT, event);
        if (batchId != null) intent.putExtra(EXTRA_BATCH_ID, batchId);
        if (error != null) intent.putExtra(EXTRA_ERROR, error);
        context.sendBroadcast(intent);
    }

    static boolean isActive(Context context) {
        return SecureListeningConfig.prefs(context).getBoolean(SESSION_ACTIVE, false);
    }

    static long sessionStartedAt(Context context) {
        return SecureListeningConfig.prefs(context).getLong(SESSION_STARTED_AT, 0);
    }

    static long sessionEndAt(Context context) {
        return SecureListeningConfig.prefs(context).getLong(SESSION_END_AT, 0);
    }

    static String sessionMode(Context context) {
        return SecureListeningConfig.prefs(context).getString(SESSION_MODE, "listen");
    }

    static String sessionFacing(Context context) {
        return SecureListeningConfig.prefs(context).getString(SESSION_FACING, "front");
    }

    private void startSessionFromIntent(Intent intent) {
        long durationMs = Math.max(180_000, Math.min(3_600_000, intent.getLongExtra("durationMs", 180_000)));
        mode = "watch".equals(intent.getStringExtra("mode")) ? "watch" : "listen";
        cameraFacing = "back".equals(intent.getStringExtra("cameraFacing")) ? "back" : "front";
        startedAt = System.currentTimeMillis();
        endAt = startedAt + durationMs;
        batchIndex = 0;
        cameraIndex = 0;
        lastCameraCaptureAt = 0;
        cameraReady = false;
        stopping = false;
        discarding = false;
        persistSession(true);
        startForegroundNow();
        acquireWakeLock(durationMs + 5 * 60_000);

        if ("watch".equals(mode)) startCamera();
        if (!startRecorder()) {
            broadcast(this, "error", null, "microphone-start-failed");
            stopSession("error");
            return;
        }
        handler.postDelayed(this::rotateSegment, Math.min(SLICE_MS, Math.max(1_000, endAt - System.currentTimeMillis())));
        handler.postDelayed(() -> stopSession("completed"), durationMs);
        ListeningBatchUploader.schedule(this);
        broadcast(this, "started", null, null);
    }

    private boolean restoreSession() {
        if (!isActive(this)) return false;
        startedAt = sessionStartedAt(this);
        endAt = sessionEndAt(this);
        if (endAt <= System.currentTimeMillis()) {
            persistSession(false);
            return false;
        }
        mode = sessionMode(this);
        cameraFacing = sessionFacing(this);
        batchIndex = Math.max(0, (int) ((System.currentTimeMillis() - startedAt) / SLICE_MS));
        cameraIndex = Math.max(0, (int) ((System.currentTimeMillis() - startedAt) / CAMERA_INTERVAL_MS));
        lastCameraCaptureAt = SecureListeningConfig.prefs(this).getLong(SESSION_LAST_CAMERA_CAPTURE_AT, 0);
        stopping = false;
        discarding = false;
        startForegroundNow();
        acquireWakeLock(endAt - System.currentTimeMillis() + 60_000);
        if ("watch".equals(mode)) startCamera();
        if (!startRecorder()) return false;
        handler.postDelayed(this::rotateSegment, Math.min(SLICE_MS, endAt - System.currentTimeMillis()));
        handler.postDelayed(() -> stopSession("completed"), endAt - System.currentTimeMillis());
        return true;
    }

    private void rotateSegment() {
        if (stopping) return;
        boolean continueRecording = System.currentTimeMillis() < endAt - 1_000;
        finishCurrentSegment(continueRecording);
        if (continueRecording) {
            handler.postDelayed(this::rotateSegment, Math.min(SLICE_MS, Math.max(1_000, endAt - System.currentTimeMillis())));
        }
    }

    private boolean startRecorder() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
        batchIndex += 1;
        String batchId = currentBatchId();
        recordingFile = ListeningBatchUploader.createMediaFile(this, batchId, "-audio.m4a");
        try {
            recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(44_100);
            recorder.setAudioEncodingBitRate(96_000);
            recorder.setOutputFile(recordingFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            return true;
        } catch (Exception error) {
            releaseRecorder(false);
            return false;
        }
    }

    private void finishCurrentSegment(boolean startNext) {
        String batchId = currentBatchId();
        File audioFile = releaseRecorder(true);
        String observedAt = isoNow();
        if (startNext && !startRecorder()) {
            broadcast(this, "error", batchId, "microphone-restart-failed");
            handler.post(() -> stopSession("error"));
        }
        if (audioFile == null) return;

        enqueueBatch(batchId, observedAt, audioFile, null, null);
    }

    private File releaseRecorder(boolean keepFile) {
        File file = recordingFile;
        recordingFile = null;
        if (recorder != null) {
            try {
                recorder.stop();
            } catch (RuntimeException error) {
                keepFile = false;
            }
            recorder.reset();
            recorder.release();
            recorder = null;
        }
        if (file != null && (!keepFile || !file.exists() || file.length() < 512)) {
            file.delete();
            return null;
        }
        return file;
    }

    private void enqueueBatch(String batchId, String observedAt, File audioFile, File imageFile, String cameraError) {
        if (discarding) {
            if (audioFile != null) audioFile.delete();
            if (imageFile != null) imageFile.delete();
            return;
        }
        try {
            ListeningBatchUploader.enqueue(this, batchId, observedAt, imageFile == null ? null : cameraFacing, audioFile, imageFile);
            broadcast(this, "batch-queued", batchId, cameraError);
            uploadExecutor.execute(() -> ListeningBatchUploader.uploadAll(getApplicationContext()));
        } catch (Exception error) {
            broadcast(this, "error", batchId, "batch-persist-failed");
        }
    }

    private void stopSession(String reason) {
        if (stopping) return;
        stopping = true;
        handler.removeCallbacksAndMessages(null);
        finishCurrentSegment(false);
        persistSession(false);
        if (camera != null) camera.close();
        camera = null;
        cameraReady = false;
        releaseWakeLock();
        broadcast(this, reason, null, null);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void clearSessionData() {
        stopping = true;
        discarding = true;
        handler.removeCallbacksAndMessages(null);
        releaseRecorder(false);
        if (camera != null) camera.close();
        camera = null;
        cameraReady = false;
        releaseWakeLock();
        persistSession(false);
        SecureListeningConfig.clear(this);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void startCamera() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            broadcast(this, "error", null, "camera-permission-missing");
            mode = "listen";
            persistSession(true);
            startForegroundNow();
            return;
        }
        try {
            if (camera != null) camera.close();
            cameraReady = false;
            CameraFrameCapture nextCamera = new CameraFrameCapture(this);
            camera = nextCamera;
            nextCamera.start(cameraFacing, new CameraFrameCapture.StateCallback() {
                @Override
                public void ready() {
                    handler.post(() -> {
                        if (stopping || !"watch".equals(mode) || camera != nextCamera) return;
                        cameraReady = true;
                        scheduleCameraCapture(0);
                    });
                }

                @Override
                public void failed(String error) {
                    handler.post(() -> {
                        if (camera == nextCamera) handleCameraFailure(error);
                    });
                }
            });
        } catch (Exception error) {
            handleCameraFailure("camera-start-failed");
        }
    }

    private void scheduleCameraCapture(long delayMs) {
        handler.postDelayed(this::captureCameraFrame, delayMs);
    }

    private void captureCameraFrame() {
        if (stopping || !"watch".equals(mode) || !cameraReady || camera == null) return;
        cameraIndex += 1;
        String batchId = "native-" + startedAt + "-camera-" + String.format(Locale.US, "%03d", cameraIndex);
        String observedAt = isoNow();
        File imageFile = ListeningBatchUploader.createMediaFile(this, batchId, "-frame.jpg");
        camera.capture(imageFile, (captured, error) -> handler.post(() -> {
            if (captured != null) {
                lastCameraCaptureAt = System.currentTimeMillis();
                SecureListeningConfig.prefs(this).edit().putLong(SESSION_LAST_CAMERA_CAPTURE_AT, lastCameraCaptureAt).apply();
                enqueueBatch(batchId, observedAt, null, captured, null);
                scheduleCameraCapture(Math.min(CAMERA_INTERVAL_MS, Math.max(1_000, endAt - System.currentTimeMillis())));
            } else {
                handleCameraFailure(error == null ? "camera-capture-failed" : error);
            }
        }));
    }

    private void handleCameraFailure(String error) {
        if (stopping || !"watch".equals(mode)) return;
        cameraReady = false;
        if (camera != null) camera.close();
        camera = null;
        broadcast(this, "camera-retrying", null, error);
        handler.postDelayed(this::startCamera, CAMERA_RETRY_MS);
    }

    private void startForegroundNow() {
        int foregroundTypes = 128; // ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if ("watch".equals(mode)) foregroundTypes |= 64; // ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), foregroundTypes);
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stopIntent = new Intent(this, PapoListeningService.class).setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(this, 1, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        SecureListeningConfig.Config config = null;
        try {
            config = SecureListeningConfig.load(this);
        } catch (Exception ignored) {}
        String name = config == null ? "Papo" : config.creatureName;
        String text = "watch".equals(mode) ? "正在后台陪你听和看" : "正在后台陪你听";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(name)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(android.R.drawable.ic_media_pause, "停止", stop)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "陪伴中", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Papo 长时间倾听和定时画面采集");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void acquireWakeLock(long timeoutMs) {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Papo:Listening");
        wakeLock.acquire(Math.max(60_000, timeoutMs));
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void persistSession(boolean active) {
        SecureListeningConfig.prefs(this).edit()
            .putBoolean(SESSION_ACTIVE, active)
            .putLong(SESSION_STARTED_AT, startedAt)
            .putLong(SESSION_END_AT, endAt)
            .putString(SESSION_MODE, mode)
            .putString(SESSION_FACING, cameraFacing)
            .putLong(SESSION_LAST_CAMERA_CAPTURE_AT, lastCameraCaptureAt)
            .apply();
    }

    private String currentBatchId() {
        return "native-" + startedAt + "-" + String.format(Locale.US, "%03d", batchIndex);
    }

    private static String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }
}
