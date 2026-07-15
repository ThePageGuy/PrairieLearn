FROM prairielearn/workspace-jupyterlab-base:latest
ARG CACHEBUST=2026-07-15-15-37-39

USER root
COPY install.sh requirements.txt /
RUN /bin/bash /install.sh

USER jovyan
