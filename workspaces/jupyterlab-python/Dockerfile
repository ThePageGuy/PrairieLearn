FROM prairielearn/workspace-jupyterlab-base:latest
ARG CACHEBUST=2026-09-15-18-03-02

USER root
COPY install.sh requirements.txt /
RUN /bin/bash /install.sh

USER jovyan
