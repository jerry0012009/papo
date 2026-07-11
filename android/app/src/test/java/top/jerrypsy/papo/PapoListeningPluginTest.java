package top.jerrypsy.papo;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PapoListeningPluginTest {
    @Test
    public void readsJavaScriptIntegerDurationsWithoutFallingBack() {
        assertEquals(900_000L, PapoListeningPlugin.requestedDurationMs(Integer.valueOf(900_000)));
        assertEquals(3_600_000L, PapoListeningPlugin.requestedDurationMs(Long.valueOf(3_600_000L)));
    }

    @Test
    public void defaultsOnlyWhenDurationIsMissing() {
        assertEquals(180_000L, PapoListeningPlugin.requestedDurationMs((Object) null));
    }
}
