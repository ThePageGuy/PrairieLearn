FROM prairielearn/workspace-jupyterlab-base:latest
ARG CACHEBUST=2026-11-15-19-39-00

USER root
COPY install.sh requirements.txt /
RUN /bin/bash /install.sh

USER jovyan
