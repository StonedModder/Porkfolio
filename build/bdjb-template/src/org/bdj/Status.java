package org.bdj;

public class Status {
    private static RemoteLogger LOGGER;
    private static volatile boolean WINDOWBOOL = false;
    private static volatile boolean LOGGERBOOL = false;

    public static void setScreenOutputEnabled(boolean windowbool) {
        WINDOWBOOL = windowbool;
    }

    public static void setNetworkLoggerEnabled(boolean networkbool) {
        LOGGERBOOL = networkbool;
    }

    private static synchronized void initLogger() {
        if (LOGGER == null) {
            LOGGER = new RemoteLogger(18194, 1000);
            LOGGER.start();
            try {
                //Give some time for log client
                Thread.sleep(1000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    public static void close() {
        synchronized (Status.class) {
            if (LOGGER != null) {
                LOGGER.stop();
                LOGGER = null;
            }
        }
    }

    public static void println(String msg) {
        println(msg, true);
    }

    public static void println(String msg, boolean showOnScreen) {
        String finalMsg = "[" + Thread.currentThread().getName() + "] " + msg;
        if (LOGGERBOOL) {
            initLogger();
            LOGGER.println(finalMsg);
        }
        if (WINDOWBOOL && showOnScreen) {
            Screen.println(finalMsg);
        }
    }

    public static void info(String msg) {
        String finalMsg = "[" + Thread.currentThread().getName() + "] " + msg;
        if (LOGGERBOOL) { initLogger(); LOGGER.println(finalMsg); }
        if (WINDOWBOOL) Screen.getInstance().print(finalMsg, Screen.MessageType.INFO, true, false);
    }

    public static void success(String msg) {
        String finalMsg = "[" + Thread.currentThread().getName() + "] " + msg;
        if (LOGGERBOOL) { initLogger(); LOGGER.println("SUCCESS: " + finalMsg); }
        if (WINDOWBOOL) Screen.getInstance().print(finalMsg, Screen.MessageType.SUCCESS, true, false);
    }

    public static void warning(String msg) {
        String finalMsg = "[" + Thread.currentThread().getName() + "] " + msg;
        if (LOGGERBOOL) { initLogger(); LOGGER.println("WARNING: " + finalMsg); }
        if (WINDOWBOOL) Screen.getInstance().print(finalMsg, Screen.MessageType.WARNING, true, false);
    }

    public static void error(String msg) {
        String finalMsg = "[" + Thread.currentThread().getName() + "] " + msg;
        if (LOGGERBOOL) { initLogger(); LOGGER.println("ERROR: " + finalMsg); }
        if (WINDOWBOOL) Screen.getInstance().print(finalMsg, Screen.MessageType.ERROR, true, false);
    }

    public static void printStackTrace(String msg, Throwable e) {
        printStackTrace(msg, e, true);
    }

    public static void printStackTrace(String msg, Throwable e, boolean showOnScreen) {
        String finalMsg = "[" + Thread.currentThread().getName() + "] " + msg;
        if (LOGGERBOOL) {
            initLogger();
            LOGGER.printStackTrace(finalMsg, e);
        }
        if (WINDOWBOOL && showOnScreen) {
            Screen.printStackTrace(finalMsg, e);
        }
    }
}
