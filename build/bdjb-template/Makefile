#   Copyright (C) 2022 John Törnblom
#
# This program is free software; you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; see the file COPYING. If not see
# <http://www.gnu.org/licenses/>.


DISC_LABEL := cyberbdjb-autoloader
VERSION    := 2.3

#
# Host tools
#
MAKEFILE_DIR := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))
BDJSDK_HOME  ?= $(MAKEFILE_DIR)/../../
BDSIGNER     := $(BDJSDK_HOME)/host/bin/bdsigner
MAKEFS       := $(BDJSDK_HOME)/host/bin/makefs
JAVA8_HOME    ?= $(BDJSDK_HOME)/host/jdk8
JAVA11_HOME    ?= $(BDJSDK_HOME)/host/jdk11
JAVAC        := $(JAVA8_HOME)/bin/javac
JAR          := $(JAVA8_HOME)/bin/jar

export JAVA8_HOME
export JAVA11_HOME


#
# Compilation artifacts
#
ifneq (,$(wildcard $(BDJSDK_HOME)/target/lib/pbp.jar))
CLASSPATH := $(BDJSDK_HOME)/target/lib/enhanced-stubs.zip:$(BDJSDK_HOME)/target/lib/bdjstack.jar:$(BDJSDK_HOME)/target/lib/pbp.jar
else
CLASSPATH := $(BDJSDK_HOME)/target/lib/enhanced-stubs.zip:$(BDJSDK_HOME)/target/lib/bdjstack.jar:$(BDJSDK_HOME)/target/lib/rt.jar
endif
SOURCES := $(wildcard src/jdk/internal/misc/*.java) $(wildcard src/org/bdj/*.java) $(wildcard src/org/bdj/sandbox/*.java) $(wildcard src/org/bdj/api/*.java) src/org/bdj/Version.java
JFLAGS        := -Xlint:-options -source 1.4 -target 1.4

#
# Disc files
#
TMPL_DIRS  := $(shell find $(BDJSDK_HOME)/resources/AVCHD/ -type d)
TMPL_FILES := $(shell find $(BDJSDK_HOME)/resources/AVCHD/ -type f)

DISC_DIRS  := $(patsubst $(BDJSDK_HOME)/resources/AVCHD%,discdir%,$(TMPL_DIRS)) \
              discdir/BDMV/JAR
DISC_FILES := $(patsubst $(BDJSDK_HOME)/resources/AVCHD%,discdir%,$(TMPL_FILES)) \
              discdir/BDMV/JAR/00000.jar


all: $(DISC_LABEL).iso

SONIC_VERSION ?= unknown

src/org/bdj/Version.java:
	@BUILD_TIME=$$(date -u +"%Y-%m-%d %H:%M:%S UTC"); \
	echo "package org.bdj;" > $@; \
	echo "public class Version {" >> $@; \
	echo "    public static final String VERSION = \"$(VERSION)\";" >> $@; \
	echo "    public static final String BUILD_TYPE = \"stable\";" >> $@; \
	echo "    public static final String HASH = \"owen\";" >> $@; \
	echo "    public static final String BUILD_TIME = \"$$BUILD_TIME\";" >> $@; \
	echo "    public static final String SONIC_VERSION = \"$(SONIC_VERSION)\";" >> $@; \
	echo "}" >> $@

discdir:
	mkdir -p $(DISC_DIRS)

discdir/BDMV/JAR/00000.jar: discdir $(SOURCES)
	$(JAVAC) $(JFLAGS) -cp $(CLASSPATH) $(SOURCES)
	mkdir -p build
	rsync -a --exclude='*.java' --exclude='*.c' --exclude='*.bak' src/ build/
	$(JAR) cf $@ -C build/ .

discdir/%: discdir
	cp $(BDJSDK_HOME)/resources/AVCHD/$* $@


$(DISC_LABEL).iso: $(DISC_FILES)
	cp -r BDMV/META discdir/BDMV/
	cp -r BDMV/BDJO discdir/BDMV/
	cp -r ps5_autoloader discdir/
	cp payload.jar discdir/
	$(MAKEFS) -m 32m -t udf -o T=bdre,v=2.50,L=$(DISC_LABEL) $@ discdir

clean:
	rm -rf build META-INF $(DISC_LABEL).iso discdir src/jdk/internal/misc/*.class src/org/bdj/*.class src/org/bdj/sandbox/*.class src/org/bdj/api/*.class src/org/bdj/Version.java
