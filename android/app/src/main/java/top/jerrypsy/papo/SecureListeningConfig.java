package top.jerrypsy.papo;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureListeningConfig {
    static final String PREFS = "papo_native_listening";
    private static final String KEY_ALIAS = "papo_listening_credentials_v1";
    private static final String CONFIG_KEY = "encrypted_config";
    private static final String IV_KEY = "encrypted_config_iv";

    static final class Config {
        final String userId;
        final String deviceToken;
        final String apiBase;
        final String creatureName;

        Config(String userId, String deviceToken, String apiBase, String creatureName) {
            this.userId = userId;
            this.deviceToken = deviceToken;
            this.apiBase = apiBase;
            this.creatureName = creatureName;
        }
    }

    private SecureListeningConfig() {}

    static void save(Context context, Config config) throws Exception {
        JSONObject json = new JSONObject();
        json.put("userId", config.userId);
        json.put("deviceToken", config.deviceToken == null ? "" : config.deviceToken);
        json.put("apiBase", config.apiBase);
        json.put("creatureName", config.creatureName == null ? "Papo" : config.creatureName);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] encrypted = cipher.doFinal(json.toString().getBytes(StandardCharsets.UTF_8));
        prefs(context).edit()
            .putString(CONFIG_KEY, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(IV_KEY, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .apply();
    }

    static Config load(Context context) throws Exception {
        SharedPreferences prefs = prefs(context);
        String encrypted = prefs.getString(CONFIG_KEY, null);
        String iv = prefs.getString(IV_KEY, null);
        if (encrypted == null || iv == null) return null;

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        String raw = new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
        JSONObject json = new JSONObject(raw);
        return new Config(
            json.getString("userId"),
            json.optString("deviceToken", ""),
            json.getString("apiBase"),
            json.optString("creatureName", "Papo")
        );
    }

    static void clear(Context context) {
        prefs(context).edit().clear().apply();
        ListeningBatchUploader.clearQueue(context);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry existing = keyStore.getEntry(KEY_ALIAS, null);
        if (existing instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) existing).getSecretKey();
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
