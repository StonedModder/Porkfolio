package org.bdj;

import java.awt.Color;
import java.awt.Container;
import java.awt.EventQueue;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Shape;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.StringTokenizer;
import java.util.Vector;

public class Screen extends Container {
    private static final long serialVersionUID = 0x4141414141414141L;

    private static final int DESIGN_W = 1920;
    private static final int DESIGN_H = 1080;
    private static final int SHELL_PAD_X = 100;
    private static final int SHELL_PAD_Y = 48;
    private static final int CONTENT_W = 1400;
    private static final int GAP = 24;

    private static final Color CP_BG = new Color(0x060810);
    private static final Color CP_CARD = new Color(0x080b14);
    private static final Color CP_PANEL = new Color(6, 8, 16, 245);
    private static final Color CP_YELLOW = new Color(0xfcee0a);
    private static final Color CP_YELLOW_D = new Color(0xc9bc00);
    private static final Color CP_CYAN = new Color(0x00f0ff);
    private static final Color CP_RED = new Color(0xff2a6d);
    private static final Color CP_GREEN = new Color(0x43ff83);
    private static final Color CP_BORDER = new Color(252, 238, 10, 56);
    private static final Color CP_HAZARD = new Color(0x0a0c14);
    private static final Color CP_DIM = new Color(252, 238, 10, 140);

    private static final String[] STAGE_MESSAGES = {
        "STANDING BY",
        "RUNNING USERLAND EXPLOIT",
        "CHAIN INITIALIZED",
        "UNSTABLE PRIMITIVE ACHIEVED",
        "RUNNING KERNEL EXPLOIT",
        "KERNEL EXPLOIT FINISHED",
        "AUTOLOAD MANIFEST READY",
        "PAYLOAD QUEUE RUNNING",
        "AUTOLOAD FINISHED"
    };

    private static final Color[] STAGE_COLORS = {
        CP_YELLOW, CP_YELLOW, CP_CYAN, CP_GREEN, CP_YELLOW,
        CP_GREEN, CP_CYAN, CP_YELLOW, CP_GREEN
    };

    private static final int[] STAGE_PCTS = {
        0, 13, 25, 38, 50, 63, 75, 88, 100
    };

    public static class MessageType {
        public static final MessageType INFO = new MessageType(CP_YELLOW);
        public static final MessageType SUCCESS = new MessageType(CP_GREEN);
        public static final MessageType ERROR = new MessageType(CP_RED);
        public static final MessageType WARNING = new MessageType(CP_CYAN);
        final Color color;
        private MessageType(Color c) { color = c; }
    }

    private static class Message {
        final String text;
        final Color color;
        Message(String t, Color c) { text = t; color = c; }
    }

    private final Font titleFont = new Font("Dialog", Font.BOLD, 72);
    private final Font badgeFont = new Font("Dialog", Font.BOLD, 16);
    private final Font statusFont = new Font("Dialog", Font.BOLD, 40);
    private final Font moduleLabelFont = new Font("Dialog", Font.BOLD, 11);
    private final Font moduleValueFont = new Font("Monospaced", Font.BOLD, 13);
    private final Font logFont = new Font("Monospaced", Font.PLAIN, 13);
    private final Font progressFont = new Font("Monospaced", Font.BOLD, 12);

    private final Vector messages = new Vector();
    private volatile boolean isPainting = false;
    private volatile boolean isDirty = false;

    private int progressPercent = 0;
    private String progressLabel = "BOOTING...";
    private String title = "BDJB AUTOLOADER";
    private int stageIndex = 0;

    private final String[] moduleValues = { "INITIALIZING", "STANDING BY", "QUEUE READY" };
    private final Color[] moduleColors = { CP_YELLOW, CP_RED, CP_CYAN };
    private static final String[] MODULE_LABELS = {
        "EXPLOIT CHAIN", "KERNEL STAGE", "PAYLOAD RUNNER"
    };

    private volatile int animTick = 0;
    private volatile boolean animRunning = false;

    private static final Screen instance = new Screen();

    private Screen() {
        super();
        setBackground(CP_BG);
        setForeground(CP_YELLOW);
        addComponentListener(new ComponentAdapter() {
            public void componentShown(ComponentEvent e) { isDirty = true; safeRepaint(); }
            public void componentHidden(ComponentEvent e) {}
        });
    }

    public void startAnimations() {
        if (animRunning) return;
        animRunning = true;
        Thread t = new Thread(new Runnable() {
            public void run() {
                while (animRunning) {
                    try { Thread.sleep(120); } catch (InterruptedException e) { break; }
                    animTick++;
                    isDirty = true;
                    safeRepaint();
                }
            }
        }, "bdjb-anim");
        t.setDaemon(true);
        t.start();
    }

    public static Screen getInstance() { return instance; }

    public static void println(String msg) { println(msg, true, false); }

    public static void println(String msg, boolean repaint, boolean replaceLast) {
        getInstance().print(msg, MessageType.INFO, repaint, replaceLast);
    }

    public void print(String msg, boolean repaint, boolean replaceLast) {
        print(msg, MessageType.INFO, repaint, replaceLast);
    }

    public void print(String msg, MessageType type, boolean repaint, boolean replaceLast) {
        if (msg == null) msg = "null";
        synchronized (messages) {
            if (replaceLast && messages.size() > 0) {
                messages.removeElementAt(messages.size() - 1);
            }
            messages.addElement(new Message(msg, type.color));
            while (messages.size() > 16) {
                messages.removeElementAt(0);
            }
            advanceStageFromMessage(msg, type);
            isDirty = true;
        }
        if (repaint) safeRepaint();
    }

    public void setTitle(String t) {
        synchronized (messages) {
            title = t != null ? t.toUpperCase() : "";
            isDirty = true;
        }
        safeRepaint();
    }

    public void setProgress(int pct, String label) {
        synchronized (messages) {
            setProgressLocked(pct, label != null ? label.toUpperCase() : "");
            isDirty = true;
        }
        safeRepaint();
    }

    private void setProgressLocked(int pct, String label) {
        progressPercent = Math.max(0, Math.min(100, pct));
        progressLabel = label != null && label.length() > 0 ? label : "BOOTING...";
        stageIndex = stageForPercent(progressPercent);
        updateModulesForStage(stageIndex);
    }

    private void advanceStageFromMessage(String msg, MessageType type) {
        String lower = msg.toLowerCase();
        int nextStage = -1;

        if (type == MessageType.ERROR || lower.indexOf("failed") >= 0 || lower.indexOf("error") >= 0) {
            progressLabel = "ERROR";
            moduleColors[1] = CP_RED;
            return;
        }

        // Stage 1: BD-J xlet started, userland / sandbox phase
        if (lower.indexOf("bd-j init") >= 0 || lower.indexOf("userland") >= 0 ||
            lower.indexOf("screen initialized") >= 0 || lower.indexOf("sandbox") >= 0 ||
            lower.indexOf("triggering") >= 0) {
            nextStage = Math.max(nextStage, 1);
        }
        // Stage 2: chain initialized — sandbox escape confirmed
        if (lower.indexOf("exploit success") >= 0 || lower.indexOf("escape achieved") >= 0 ||
            lower.indexOf("chain initialized") >= 0) {
            nextStage = Math.max(nextStage, 2);
        }
        // Stage 3: primitive / pre-kernel prep
        if (lower.indexOf("primitive") >= 0 || lower.indexOf("unstable") >= 0) {
            nextStage = Math.max(nextStage, 3);
        }
        // Stage 4: kernel exploit running (Poopsloit IS the kernel exploit)
        if (lower.indexOf("poopsloit") >= 0 || lower.indexOf("running kernel") >= 0 ||
            lower.indexOf("starting kernel") >= 0 || lower.indexOf("kernel exploit") >= 0) {
            // Only advance to 4, not 5, unless "finished" or "patched" is present
            if (lower.indexOf("finished") < 0 && lower.indexOf("patched") < 0) {
                nextStage = Math.max(nextStage, 4);
            }
        }
        // Stage 5: kernel exploit finished
        if ((lower.indexOf("kernel") >= 0 || lower.indexOf("poopsloit") >= 0) &&
            (lower.indexOf("finished") >= 0 || lower.indexOf("patched") >= 0)) {
            nextStage = Math.max(nextStage, 5);
        }
        // Stage 6: autoload manifest / sonic-loader config ready
        if (lower.indexOf("manifest") >= 0 || lower.indexOf("autoload config") >= 0 ||
            lower.indexOf("autoload.txt") >= 0 || lower.indexOf("sonic-loader") >= 0 ||
            lower.indexOf("sonic loader") >= 0 || lower.indexOf("killdiscplayer") >= 0) {
            nextStage = Math.max(nextStage, 6);
        }
        // Stage 7: payload/ELF queue starting — explicit loading phrases only
        if (lower.indexOf("loading elf") >= 0 || lower.indexOf("elf loader") >= 0 ||
            lower.indexOf("loading jar") >= 0 || lower.indexOf("loading payload") >= 0 ||
            lower.indexOf("launching payload") >= 0 || lower.indexOf("payload queue") >= 0) {
            nextStage = Math.max(nextStage, 7);
        }
        // Stage 8: fully complete — very specific phrases only
        if (lower.indexOf("autoload finished") >= 0 || lower.indexOf("autoload complete") >= 0 ||
            lower.indexOf("all payloads loaded") >= 0) {
            nextStage = Math.max(nextStage, 8);
        }

        if (nextStage > stageIndex) {
            stageIndex = nextStage;
            progressPercent = STAGE_PCTS[stageIndex];
            progressLabel = STAGE_MESSAGES[stageIndex];
            updateModulesForStage(stageIndex);
        }
    }

    private int stageForPercent(int pct) {
        int stage = 0;
        for (int i = 0; i < STAGE_PCTS.length; i++) {
            if (pct >= STAGE_PCTS[i]) stage = i;
        }
        return stage;
    }

    private void updateModulesForStage(int stage) {
        if (stage >= 8) {
            moduleValues[0] = "COMPLETE";
            moduleValues[1] = "PATCHED";
            moduleValues[2] = "RUNNING";
            moduleColors[0] = CP_GREEN;
            moduleColors[1] = CP_GREEN;
            moduleColors[2] = CP_CYAN;
        } else if (stage >= 6) {
            moduleValues[0] = "BYPASSED";
            moduleValues[1] = "PATCHED";
            moduleValues[2] = "LOADING";
            moduleColors[0] = CP_GREEN;
            moduleColors[1] = CP_GREEN;
            moduleColors[2] = CP_CYAN;
        } else if (stage >= 4) {
            moduleValues[0] = "BYPASSED";
            moduleValues[1] = "PATCHING";
            moduleValues[2] = "QUEUE READY";
            moduleColors[0] = CP_GREEN;
            moduleColors[1] = CP_RED;
            moduleColors[2] = CP_CYAN;
        } else if (stage >= 2) {
            moduleValues[0] = "ACTIVE";
            moduleValues[1] = "STANDING BY";
            moduleValues[2] = "QUEUE READY";
            moduleColors[0] = CP_YELLOW;
            moduleColors[1] = CP_RED;
            moduleColors[2] = CP_CYAN;
        } else {
            moduleValues[0] = "INITIALIZING";
            moduleValues[1] = "STANDING BY";
            moduleValues[2] = "QUEUE READY";
            moduleColors[0] = CP_YELLOW;
            moduleColors[1] = CP_RED;
            moduleColors[2] = CP_CYAN;
        }
    }

    public static void printStackTrace(String msg, Throwable e) {
        println(msg, true, false);
        getInstance().printStackTrace(e);
    }

    public void printStackTrace(Throwable e) {
        if (e == null) { print("null exception", true, false); return; }
        StringTokenizer st; StringBuffer sb;
        try {
            StringWriter sw = new StringWriter();
            try {
                PrintWriter pw = new PrintWriter(sw);
                try { e.printStackTrace(pw); pw.flush(); } finally { pw.close(); }
                st = new StringTokenizer(sw.toString(), "\n", false);
                sb = new StringBuffer();
            } finally { sw.close(); }
            Vector lines = new Vector();
            while (st.hasMoreTokens()) {
                String line = st.nextToken(); sb.setLength(0);
                for (int i = 0; i < line.length(); i++) {
                    char c = line.charAt(i);
                    if (c == '\t') sb.append("   ");
                    else if (c != '\r') sb.append(c);
                }
                lines.addElement(sb.toString());
            }
            synchronized (messages) {
                for (int i = 0; i < lines.size(); i++) {
                    print((String) lines.elementAt(i), false, false);
                }
            }
            safeRepaint();
        } catch (IOException ex) { printThrowable(e); }
    }

    public void printThrowable(Throwable e) {
        if (e == null) { print("null throwable", true, false); return; }
        String m = e.getMessage();
        print(e.getClass().getName() + ": " + (m != null ? m : ""), true, false);
    }

    private void safeRepaint() {
        if (EventQueue.isDispatchThread()) {
            if (isDisplayable()) repaint();
        } else {
            EventQueue.invokeLater(new Runnable() {
                public void run() { if (isDisplayable()) repaint(); }
            });
        }
    }

    public void update(Graphics g) { paint(g); }

    public void paint(Graphics g) {
        if (g == null) return;

        Vector msgCopy;
        int pct;
        String pLabel;
        String ttl;
        String[] modVals;
        Color[] modCols;
        int tick;
        int stage;
        boolean needRepaint = false;

        synchronized (messages) {
            if (isPainting) return;
            isPainting = true;
            isDirty = false;
            msgCopy = new Vector(messages);
            pct = progressPercent;
            pLabel = progressLabel;
            ttl = title;
            stage = stageIndex;
            modVals = new String[] { moduleValues[0], moduleValues[1], moduleValues[2] };
            modCols = new Color[] { moduleColors[0], moduleColors[1], moduleColors[2] };
            tick = animTick;
        }

        try {
            int W = getWidth();
            int H = getHeight();
            if (W <= 0 || H <= 0) return;

            g.setColor(CP_BG);
            g.fillRect(0, 0, W, H);

            double sx = W / (double) DESIGN_W;
            double sy = H / (double) DESIGN_H;
            double scale = sx < sy ? sx : sy;
            int shellW = (int) (DESIGN_W * scale);
            int shellH = (int) (DESIGN_H * scale);
            int ox = (W - shellW) / 2;
            int oy = (H - shellH) / 2;

            Shape oldClip = g.getClip();
            g.setClip(ox, oy, shellW, shellH);
            drawScaledShell(g, ox, oy, scale, msgCopy, pct, pLabel, ttl, modVals, modCols, tick, stage);
            g.setClip(oldClip);
        } finally {
            synchronized (messages) {
                isPainting = false;
                if (isDirty) needRepaint = true;
            }
            if (needRepaint) safeRepaint();
        }
    }

    private void drawScaledShell(Graphics g, int ox, int oy, double s, Vector msgCopy, int pct,
                                 String pLabel, String ttl, String[] modVals, Color[] modCols,
                                 int tick, int stage) {
        int shellW = sc(DESIGN_W, s);
        int shellH = sc(DESIGN_H, s);
        int padX = sc(SHELL_PAD_X, s);
        int contentW = sc(CONTENT_W, s);
        int cx = ox + (shellW - contentW) / 2;
        int top = oy + (shellH - sc(704, s)) / 2;

        drawBackground(g, ox, oy, shellW, shellH, s, tick);
        hazardStripe(g, ox, oy, shellW, sc(6, s), true, s);
        hazardStripe(g, ox, oy + shellH - sc(6, s), shellW, sc(6, s), false, s);

        int y = top;
        y = drawTitle(g, ttl, ox, shellW, y, s, tick);
        y += sc(GAP, s);
        y = drawEffectsRow(g, ox + padX, oy, shellW - padX * 2, y, s, tick, stage);
        y += sc(GAP, s);
        y = drawModuleGrid(g, cx, y, contentW, modVals, modCols, tick, s, stage);
        y += sc(GAP, s);
        y = drawLog(g, cx, y, contentW, msgCopy, s);
        y += sc(GAP, s);
        drawProgress(g, cx, y, contentW, pct, pLabel, s, tick);

        drawScanlines(g, ox, oy, shellW, shellH, s, tick);
        drawCornerBrackets(g, ox, oy, shellW, shellH, s, tick);
    }

    private void drawBackground(Graphics g, int x, int y, int w, int h, double s, int tick) {
        g.setColor(CP_BG);
        g.fillRect(x, y, w, h);

        int gridBig = Math.max(1, sc(60, s));
        int gridSmall = Math.max(1, sc(20, s));
        int bigOffset = (tick * Math.max(1, sc(2, s))) % gridBig;
        int smallOffset = (tick * Math.max(1, sc(1, s))) % gridSmall;

        g.setColor(new Color(252, 238, 10, 8));
        for (int gx = x - gridBig + bigOffset; gx < x + w; gx += gridBig) g.drawLine(gx, y, gx, y + h);
        for (int gy = y - gridBig + bigOffset; gy < y + h; gy += gridBig) g.drawLine(x, gy, x + w, gy);

        g.setColor(new Color(0, 240, 255, 6));
        for (int gx = x - gridSmall + smallOffset; gx < x + w; gx += gridSmall) g.drawLine(gx, y, gx, y + h);
        for (int gy = y - gridSmall + smallOffset; gy < y + h; gy += gridSmall) g.drawLine(x, gy, x + w, gy);

        g.setColor(new Color(252, 238, 10, 9));
        g.fillOval(x + w / 2 - sc(560, s), y + h - sc(180, s), sc(1120, s), sc(360, s));
        g.setColor(new Color(255, 42, 109, 8));
        g.fillOval(x + sc(120, s), y + sc(470, s), sc(520, s), sc(380, s));
        g.setColor(new Color(0, 240, 255, 7));
        g.fillOval(x + w - sc(640, s), y + sc(470, s), sc(520, s), sc(380, s));
    }

    private int drawTitle(Graphics g, String ttl, int ox, int shellW, int y, double s, int tick) {
        Font f = scaleFont(titleFont, s);
        g.setFont(f);
        String text = ttl.toUpperCase();
        int tracking = sc(18, s);
        int width = trackedWidth(g, text, tracking);
        int x = ox + (shellW - width) / 2;
        int baseline = y + sc(70, s);

        if (tick % 18 < 3) {
            g.setColor(new Color(255, 42, 109, 150));
            drawTrackedString(g, text, x - sc(3, s), baseline, tracking);
            g.setColor(new Color(0, 240, 255, 150));
            drawTrackedString(g, text, x + sc(3, s), baseline, tracking);
        }

        g.setColor(CP_YELLOW);
        drawTrackedString(g, text, x, baseline, tracking);
        g.setColor(new Color(252, 238, 10, 110));
        g.drawLine(x, baseline + sc(8, s), x + width, baseline + sc(8, s));
        return y + sc(86, s);
    }

    private int drawEffectsRow(Graphics g, int x, int oy, int w, int y, double s, int tick, int stage) {
        int rowH = sc(72, s);
        int gap = sc(40, s);
        int baseline = y + sc(44, s);

        String status = STAGE_MESSAGES[stage];
        Color statusColor = STAGE_COLORS[stage];
        String[] texts = {
            "v" + Version.VERSION,
            "StonedModder",
            "Sonic Loader " + Version.SONIC_VERSION,
            status
        };
        int[] widths = {
            badgeWidth(g, texts[0], s),
            badgeWidth(g, texts[1], s),
            badgeWidth(g, texts[2], s),
            trackedWidthWithFont(g, texts[3], scaleFont(statusFont, s), sc(12, s))
        };

        int clusterW = widths[0] + widths[1] + widths[2] + widths[3] + gap * 3;
        int startX = x + (w - clusterW) / 2;
        int ruleY = y + sc(36, s);
        g.setColor(new Color(252, 238, 10, 88));
        g.drawLine(x, ruleY, startX - gap / 2, ruleY);
        g.drawLine(startX + clusterW + gap / 2, ruleY, x + w, ruleY);

        int bx = startX;
        drawBadge(g, bx, y + sc(18, s), texts[0], CP_CYAN, s, tick, 0);
        bx += widths[0] + gap;
        drawBadge(g, bx, y + sc(18, s), texts[1], CP_RED, s, tick, 1);
        bx += widths[1] + gap;
        drawBadge(g, bx, y + sc(18, s), texts[2], CP_YELLOW, s, tick, 2);
        bx += widths[2] + gap;

        drawStatusText(g, texts[3], bx, baseline, statusColor, s, tick);
        return y + rowH;
    }

    private int drawModuleGrid(Graphics g, int x, int y, int w, String[] values, Color[] colors, int tick, double s, int stage) {
        int arrowW = sc(32, s);
        int cardW = (w - arrowW * 2) / 3;
        int cardH = sc(112, s);
        // nc-stage-active: card currently being processed (not complete, not pending)
        int activeCard = (stage >= 6) ? 2 : (stage >= 4) ? 1 : 0;
        for (int i = 0; i < 3; i++) {
            int mx = x + i * (cardW + arrowW);
            boolean cardGlow = (i == activeCard && stage > 0 && stage < 8);
            drawModule(g, mx, y, cardW, cardH, MODULE_LABELS[i], values[i], colors[i], i, tick, s, cardGlow);
            if (i < 2) {
                drawPipelineArrow(g, mx + cardW, y, arrowW, cardH, i, stage, tick, s);
            }
        }
        return y + cardH;
    }

    private void drawPipelineArrow(Graphics g, int x, int y, int w, int h, int arrowIdx, int stage, int tick, double s) {
        boolean done   = (arrowIdx == 0) ? (stage >= 5) : (stage >= 7);
        boolean active = (arrowIdx == 0) ? (stage >= 2 && stage < 5) : (stage >= 5 && stage < 7);

        Color base = done ? CP_CYAN : CP_YELLOW;
        int alpha;
        int charSpacing; // design-pixel letter-spacing offset (nc-arrow-flow: -8px to -2px)

        if (done) {
            alpha = 130;
            charSpacing = -2;
        } else if (active) {
            // nc-arrow-flow: 0.7s period → freq = 2π / (0.7s / 0.12s per tick) = 1.078 rad/tick
            // opacity: 0.25 → 1.0 → 0.25  (CSS: opacity 0.25 at 0%/100%, 1 at 50%)
            double wave = 0.5 + 0.5 * Math.sin(tick * 1.078 + arrowIdx * 3.14159);
            alpha = (int)(64 + 191 * wave); // 64 = 0.25*255,  191 = (1.0-0.25)*255
            // letter-spacing: -8px (compressed, dim) → -2px (open, bright)
            charSpacing = (int)(-8 + 6 * wave);
        } else {
            alpha = 20;
            charSpacing = -8; // maximally compressed when pending
        }

        Font f = new Font("Dialog", Font.BOLD, Math.max(1, sc(18, s)));
        g.setFont(f);
        FontMetrics fm = g.getFontMetrics();
        int charW = fm.charWidth('>');
        int spacing = sc(charSpacing, s);
        // Total width of ">>>" with custom letter-spacing
        int totalW = charW * 3 + 2 * spacing;
        int tx = x + (w - totalW) / 2;
        int ty = y + h / 2 + fm.getAscent() / 2 - fm.getDescent();

        int clampedAlpha = Math.max(0, Math.min(255, alpha));
        g.setColor(new Color(base.getRed(), base.getGreen(), base.getBlue(), clampedAlpha));
        // Draw each '>' with custom tracking (nc-arrow-flow letter-spacing effect)
        int cx2 = tx;
        for (int k = 0; k < 3; k++) {
            g.drawString(">", cx2, ty);
            if (k < 2) cx2 += charW + spacing;
        }

        // Flanking horizontal tick lines (expand as arrows compress, matching CSS feel)
        int lineY = y + h / 2;
        int lineAlpha = clampedAlpha / 4;
        g.setColor(new Color(base.getRed(), base.getGreen(), base.getBlue(), Math.max(0, lineAlpha)));
        int leftEnd  = tx - sc(4, s);
        int rightStart = tx + totalW + sc(4, s);
        if (leftEnd > x + sc(4, s))
            g.drawLine(x + sc(4, s), lineY, leftEnd, lineY);
        if (rightStart < x + w - sc(4, s))
            g.drawLine(rightStart, lineY, x + w - sc(4, s), lineY);
    }

    private int drawLog(Graphics g, int x, int y, int w, Vector msgCopy, double s) {
        int headerH = sc(32, s);
        int padX = sc(18, s);
        int padY = sc(12, s);
        int streamH = sc(240, s);
        int panelH = headerH + padY + streamH + padY;

        drawCyberPanel(g, x, y, w, panelH, CP_YELLOW, true, s);

        // Header row: "// EVENT STREAM"
        g.setFont(scaleFont(moduleLabelFont, s));
        FontMetrics hfm = g.getFontMetrics();
        int headerBaseline = y + (headerH + hfm.getAscent()) / 2 - sc(1, s);
        g.setColor(new Color(0, 240, 255, 160));
        g.drawString("//", x + padX, headerBaseline);
        g.setColor(CP_DIM);
        g.drawString(" EVENT STREAM", x + padX + hfm.stringWidth("//"), headerBaseline);

        // Separator below header
        g.setColor(new Color(252, 238, 10, 35));
        g.drawLine(x + sc(3, s), y + headerH, x + w - sc(1, s), y + headerH);

        // Log entries
        g.setFont(scaleFont(logFont, s));
        FontMetrics fm = g.getFontMetrics();
        int lineH = Math.max(1, sc(24, s));
        int maxLines = Math.max(1, streamH / lineH);
        int start = Math.max(0, msgCopy.size() - maxLines);

        Shape clip = g.getClip();
        int streamTop = y + headerH + padY;
        g.setClip(x + padX, streamTop, w - padX * 2, streamH);
        int ly = streamTop + fm.getAscent();
        for (int i = start; i < msgCopy.size(); i++) {
            Message m = (Message) msgCopy.elementAt(i);
            g.setColor(new Color(252, 238, 10, 90));
            g.drawString(">", x + padX, ly);
            g.setColor(m.color);
            g.drawString(shorten(m.text, fm, w - padX * 2 - sc(18, s)), x + padX + sc(18, s), ly);
            ly += lineH;
        }
        g.setClip(clip);
        return y + panelH;
    }

    private void drawProgress(Graphics g, int x, int y, int w, int pct, String label, double s, int tick) {
        int h = sc(32, s);
        g.setColor(CP_CARD);
        g.fillRect(x, y, w, h);
        g.setColor(new Color(252, 238, 10, 56));
        g.drawRect(x, y, w, h);

        int fillW = (int) ((w - 2) * pct / 100.0);
        if (fillW > 0) {
            g.setColor(CP_YELLOW);
            g.fillRect(x + 1, y + 1, fillW, h - 1);
            drawMovingStripes(g, x + 1, y + 1, fillW, h - 1, CP_BG, tick, s);
        }

        g.setFont(scaleFont(progressFont, s));
        FontMetrics fm = g.getFontMetrics();
        String text = label != null && label.length() > 0 ? label.toUpperCase() : "BOOTING...";
        int tx = x + (w - fm.stringWidth(text)) / 2;
        int by = y + (h + fm.getAscent()) / 2 - sc(1, s);
        g.setColor(CP_BG);
        g.drawString(text, tx, by);
    }

    private void drawBadge(Graphics g, int x, int y, String text, Color c, double s, int tick, int style) {
        Font f = scaleFont(badgeFont, s);
        g.setFont(f);
        FontMetrics fm = g.getFontMetrics();
        int padX = sc(22, s);
        int padY = sc(8, s);
        int cut = sc(8, s);
        int bw = fm.stringWidth(text) + padX * 2;
        int bh = fm.getHeight() + padY * 2;

        int bgAlpha = style == 1 && tick % 16 < 8 ? 42 : 18;
        int[] xs = { x + cut, x + bw, x + bw - cut, x };
        int[] ys = { y, y, y + bh, y + bh };
        g.setColor(new Color(c.getRed(), c.getGreen(), c.getBlue(), bgAlpha));
        g.fillPolygon(xs, ys, 4);
        g.setColor(new Color(c.getRed(), c.getGreen(), c.getBlue(), 170));
        g.drawPolygon(xs, ys, 4);

        if (style == 0 && tick % 24 < 4) {
            g.setColor(new Color(0, 240, 255, 90));
            g.drawPolygon(new int[] { xs[0] + sc(2, s), xs[1] + sc(2, s), xs[2] + sc(2, s), xs[3] + sc(2, s) }, ys, 4);
        }
        if (style == 2) {
            int pulse = tick % 10 < 5 ? 85 : 35;
            g.setColor(new Color(c.getRed(), c.getGreen(), c.getBlue(), pulse));
            g.drawRect(x - sc(2, s), y - sc(2, s), bw + sc(4, s), bh + sc(4, s));
        }

        g.setColor(c);
        g.drawString(text, x + padX, y + padY + fm.getAscent());
    }

    private void drawStatusText(Graphics g, String text, int x, int baseline, Color c, double s, int tick) {
        Font f = scaleFont(statusFont, s);
        int tracking = sc(12, s);
        g.setFont(f);
        if (tick % 25 < 6) {
            g.setColor(new Color(CP_CYAN.getRed(), CP_CYAN.getGreen(), CP_CYAN.getBlue(), 130));
            drawTrackedString(g, text, x - sc(2, s), baseline, tracking);
            g.setColor(new Color(CP_RED.getRed(), CP_RED.getGreen(), CP_RED.getBlue(), 130));
            drawTrackedString(g, text, x + sc(2, s), baseline, tracking);
        }
        g.setColor(c);
        drawTrackedString(g, text, x, baseline, tracking);
    }

    private void drawModule(Graphics g, int x, int y, int w, int h, String label, String value,
                            Color accent, int index, int tick, double s, boolean stageGlow) {
        boolean active = isModuleActive(value);

        // nc-stage-glow: 1.4s period — pulsing outer border glow on the active stage card
        if (stageGlow) {
            double glowWave = 0.5 + 0.5 * Math.sin(tick * 0.5389); // 2π / (1.4/0.12) = 0.5389
            int ga = (int)((0.45 + 0.35 * glowWave) * 255); // 115-204
            for (int layer = 3; layer >= 1; layer--) {
                int pad = sc(layer * 3, s);
                int la = ga / layer;
                g.setColor(new Color(CP_YELLOW.getRed(), CP_YELLOW.getGreen(), CP_YELLOW.getBlue(), Math.min(255, la)));
                g.drawRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
            }
        }

        drawCyberPanel(g, x, y, w, h, active && tick % 12 < 6 ? CP_YELLOW : accent, false, s);

        int padX = sc(26, s);
        int top = y + sc(20, s);

        g.setFont(scaleFont(moduleLabelFont, s));
        g.setColor(CP_DIM);
        g.drawString("// " + label, x + padX, top + g.getFontMetrics().getAscent());

        g.setFont(scaleFont(moduleValueFont, s));
        g.setColor(tick % 42 == 40 ? new Color(accent.getRed(), accent.getGreen(), accent.getBlue(), 110) : accent);
        g.drawString(value, x + padX, top + sc(34, s));

        if (active) {
            // nc-dot-pulse: 1.2s period (10 ticks), CSS border-radius:50% → use fillOval
            int dot = sc(6, s);
            int pulse = tick % 10 < 5 ? sc(2, s) : 0;
            g.setColor(tick % 10 < 5 ? CP_YELLOW : CP_YELLOW_D);
            g.fillOval(x + w - sc(22, s) - pulse, y + sc(15, s) - pulse, dot + pulse * 2, dot + pulse * 2);
        }

        int meterX = x + padX;
        int meterY = y + h - sc(24, s);
        int meterW = w - padX * 2;
        int meterH = sc(4, s);
        g.setColor(new Color(255, 255, 255, 10));
        g.fillRect(meterX, meterY, meterW, meterH);

        int fill = moduleFillWidth(value, meterW, tick, index);
        g.setColor(new Color(accent.getRed(), accent.getGreen(), accent.getBlue(), 210));
        g.fillRect(meterX, meterY, fill, meterH);
        drawMovingStripes(g, meterX, meterY, fill, meterH, new Color(255, 255, 255, 35), tick, s);
    }

    private void drawCyberPanel(Graphics g, int x, int y, int w, int h, Color accent, boolean logStyle, double s) {
        int cut = sc(20, s);
        int[] xs = { x, x + w - cut, x + w, x + w, x + cut, x };
        int[] ys = { y, y, y + cut, y + h, y + h, y + h - cut };
        g.setColor(logStyle ? CP_PANEL : CP_CARD);
        g.fillPolygon(xs, ys, 6);

        g.setColor(new Color(accent.getRed(), accent.getGreen(), accent.getBlue(), 210));
        g.drawLine(x, y, x + w - cut, y);
        g.drawLine(x, y, x, y + h - cut);
        g.drawLine(x + w - cut, y, x + w, y + cut);

        g.setColor(CP_BORDER);
        g.drawLine(x + w, y + cut, x + w, y + h);
        g.drawLine(x + cut, y + h, x + w, y + h);
        g.drawLine(x, y + h - cut, x + cut, y + h);

        g.setColor(new Color(CP_RED.getRed(), CP_RED.getGreen(), CP_RED.getBlue(), 220));
        g.drawLine(x + w - cut, y + h, x + w, y + h);
        g.drawLine(x + w, y + h - cut, x + w, y + h);

        if (logStyle) {
            g.setColor(CP_YELLOW);
            g.fillRect(x, y, sc(3, s), h);
        }
    }

    private void hazardStripe(Graphics g, int x, int y, int w, int h, boolean top, double s) {
        int yellow = sc(24, s);
        int dark = sc(12, s);
        int total = yellow + dark;
        for (int i = x; i < x + w; i += total) {
            int rem = x + w - i;
            if (top) {
                g.setColor(CP_YELLOW);
                g.fillRect(i, y, Math.min(yellow, rem), h);
                g.setColor(CP_HAZARD);
                g.fillRect(i + yellow, y, Math.min(dark, Math.max(0, rem - yellow)), h);
            } else {
                g.setColor(CP_HAZARD);
                g.fillRect(i, y, Math.min(dark, rem), h);
                g.setColor(CP_YELLOW);
                g.fillRect(i + dark, y, Math.min(yellow, Math.max(0, rem - dark)), h);
            }
        }
        g.setColor(new Color(252, 238, 10, 90));
        g.drawLine(x, top ? y + h : y - 1, x + w, top ? y + h : y - 1);
    }

    private void drawScanlines(Graphics g, int x, int y, int w, int h, double s, int tick) {
        int spacing = Math.max(2, sc(4, s));
        int offset = tick % spacing;
        g.setColor(new Color(0, 0, 0, tick % 2 == 0 ? 38 : 28));
        for (int sy = y + offset; sy < y + h; sy += spacing) {
            g.drawLine(x, sy, x + w, sy);
        }
    }

    private void drawCornerBrackets(Graphics g, int x, int y, int w, int h, double s, int tick) {
        int len = sc(46, s);
        int inset = sc(32, s);
        Color c = tick % 18 < 9 ? new Color(252, 238, 10, 140) : new Color(252, 238, 10, 80);
        g.setColor(c);
        g.drawLine(x + inset, y + inset, x + inset + len, y + inset);
        g.drawLine(x + inset, y + inset, x + inset, y + inset + len);
        g.drawLine(x + w - inset - len, y + inset, x + w - inset, y + inset);
        g.drawLine(x + w - inset, y + inset, x + w - inset, y + inset + len);
        g.drawLine(x + inset, y + h - inset, x + inset + len, y + h - inset);
        g.drawLine(x + inset, y + h - inset - len, x + inset, y + h - inset);
        g.drawLine(x + w - inset - len, y + h - inset, x + w - inset, y + h - inset);
        g.drawLine(x + w - inset, y + h - inset - len, x + w - inset, y + h - inset);
    }

    private void drawMovingStripes(Graphics g, int x, int y, int w, int h, Color c, int tick, double s) {
        if (w <= 0 || h <= 0) return;
        Shape clip = g.getClip();
        g.setClip(x, y, w, h);
        g.setColor(c);
        int step = Math.max(4, sc(12, s));
        int offset = (tick * Math.max(1, sc(2, s))) % step;
        for (int sx = x - h - step + offset; sx < x + w + h; sx += step) {
            g.drawLine(sx, y + h, sx + h, y);
        }
        g.setClip(clip);
    }

    private int moduleFillWidth(String value, int meterW, int tick, int index) {
        if (value.equals("COMPLETE") || value.equals("PATCHED") || value.equals("RUNNING") || value.equals("BYPASSED")) {
            return meterW;
        }
        if (value.equals("ACTIVE") || value.equals("EXECUTING") || value.equals("LOADING") || value.equals("PATCHING")) {
            int base = index == 0 ? 38 : (index == 1 ? 18 : 72);
            int wobble = tick % 14 < 7 ? 4 : 0;
            return meterW * Math.min(100, base + wobble) / 100;
        }
        return meterW * 8 / 100;
    }

    private boolean isModuleActive(String value) {
        return value.equals("ACTIVE") || value.equals("EXECUTING") || value.equals("LOADING")
            || value.equals("PATCHING") || value.equals("BYPASSED") || value.equals("PATCHED")
            || value.equals("COMPLETE") || value.equals("RUNNING");
    }

    private int badgeWidth(Graphics g, String text, double s) {
        Font old = g.getFont();
        g.setFont(scaleFont(badgeFont, s));
        int width = g.getFontMetrics().stringWidth(text) + sc(44, s);
        g.setFont(old);
        return width;
    }

    private int trackedWidthWithFont(Graphics g, String text, Font f, int tracking) {
        Font old = g.getFont();
        g.setFont(f);
        int width = trackedWidth(g, text, tracking);
        g.setFont(old);
        return width;
    }

    private int trackedWidth(Graphics g, String text, int tracking) {
        FontMetrics fm = g.getFontMetrics();
        int width = 0;
        for (int i = 0; i < text.length(); i++) {
            width += fm.charWidth(text.charAt(i));
            if (i < text.length() - 1) width += tracking;
        }
        return width;
    }

    private void drawTrackedString(Graphics g, String text, int x, int y, int tracking) {
        FontMetrics fm = g.getFontMetrics();
        int cx = x;
        for (int i = 0; i < text.length(); i++) {
            String ch = text.substring(i, i + 1);
            g.drawString(ch, cx, y);
            cx += fm.charWidth(text.charAt(i)) + tracking;
        }
    }

    private String shorten(String text, FontMetrics fm, int maxWidth) {
        if (fm.stringWidth(text) <= maxWidth) return text;
        String ellipsis = "...";
        int limit = text.length();
        while (limit > 0 && fm.stringWidth(text.substring(0, limit) + ellipsis) > maxWidth) {
            limit--;
        }
        return limit > 0 ? text.substring(0, limit) + ellipsis : ellipsis;
    }

    private Font scaleFont(Font base, double s) {
        int size = Math.max(1, (int) Math.round(base.getSize() * s));
        return new Font(base.getName(), base.getStyle(), size);
    }

    private int sc(int value, double s) {
        return (int) Math.round(value * s);
    }

    public static void clear() { getInstance().clearMessages(); }

    public void clearMessages() {
        synchronized (messages) {
            messages.removeAllElements();
            setProgressLocked(0, "BOOTING...");
            isDirty = true;
        }
        safeRepaint();
    }
}
