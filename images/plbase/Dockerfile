FROM amazonlinux:2023
ARG CACHEBUST=2025-05-15-14-24-54

COPY plbase-install.sh python-requirements.txt /

RUN /bin/bash /plbase-install.sh

CMD [ "/bin/bash" ]
